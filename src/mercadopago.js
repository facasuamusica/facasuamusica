// Adaptador do Mercado Pago — unico ponto do codigo que conhece a API deles.
// Documentacao: https://www.mercadopago.com.br/developers

const API_BASE = 'https://api.mercadopago.com';
const TIMEOUT_MS = 20000;

// Catalogo fica no servidor. Se o preco viesse do navegador, bastaria editar a
// requisicao para comprar 7 creditos por um centavo.
export const PACOTES = {
  p1: { creditos: 1, valorCentavos: 4700, titulo: '1 musica personalizada' },
  p3: { creditos: 3, valorCentavos: 8700, titulo: '3 musicas personalizadas' },
  p7: { creditos: 7, valorCentavos: 14700, titulo: '7 musicas personalizadas' }
};

export class MercadoPagoError extends Error {
  constructor(mensagem, status = 502) {
    super(mensagem);
    this.name = 'MercadoPagoError';
    this.status = status;
  }
}

async function chamar(env, caminho, { method = 'GET', body, idempotencia } = {}) {
  const token = env.MP_ACCESS_TOKEN;

  if (!token) {
    throw new MercadoPagoError('MP_ACCESS_TOKEN nao configurado no Worker.', 503);
  }

  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Evita cobrar duas vezes se a nossa propria chamada for repetida.
  if (idempotencia) headers['X-Idempotency-Key'] = idempotencia;

  let resposta;
  try {
    resposta = await fetch(`${API_BASE}${caminho}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (erro) {
    const expirou = erro.name === 'TimeoutError' || erro.name === 'AbortError';
    throw new MercadoPagoError(
      expirou ? 'O Mercado Pago demorou demais para responder.' : 'Nao foi possivel falar com o Mercado Pago.',
      504
    );
  }

  const texto = await resposta.text();
  let dados = {};
  if (texto) {
    try {
      dados = JSON.parse(texto);
    } catch {
      dados = {};
    }
  }

  if (!resposta.ok) {
    const detalhe = dados?.message || dados?.error || `HTTP ${resposta.status}`;
    throw new MercadoPagoError(
      `Mercado Pago respondeu com erro: ${detalhe}`,
      resposta.status >= 500 ? 502 : 500
    );
  }

  return dados;
}

/**
 * Cria a preferencia de pagamento (a tela de checkout do Mercado Pago).
 * O external_reference carrega o id do pedido, que e como reencontramos a
 * compra quando a notificacao chegar.
 */
export async function criarPreferencia(env, { pedidoId, pacote, nome, email, origem }) {
  const item = PACOTES[pacote];

  if (!item) {
    throw new MercadoPagoError('Pacote invalido.', 400);
  }

  const preferencia = await chamar(env, '/checkout/preferences', {
    method: 'POST',
    idempotencia: pedidoId,
    body: {
      items: [
        {
          id: pacote,
          title: item.titulo,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: item.valorCentavos / 100
        }
      ],
      payer: { name: nome, email },
      external_reference: pedidoId,
      notification_url: `${origem}/api/webhook/mercadopago`,
      back_urls: {
        success: `${origem}/pedido/${pedidoId}`,
        pending: `${origem}/pedido/${pedidoId}`,
        failure: `${origem}/pedido/${pedidoId}`
      },
      auto_return: 'approved'
    }
  });

  return {
    id: preferencia.id,
    // init_point e a URL real; sandbox_init_point so existe com credencial de teste.
    checkoutUrl: preferencia.init_point || preferencia.sandbox_init_point || null
  };
}

/** Consulta um pagamento. E daqui que sai a verdade sobre valor e status. */
export async function consultarPagamento(env, pagamentoId) {
  const pagamento = await chamar(env, `/v1/payments/${encodeURIComponent(pagamentoId)}`);

  return {
    id: String(pagamento.id ?? ''),
    status: pagamento.status ?? null,
    valorCentavos: Math.round((pagamento.transaction_amount ?? 0) * 100),
    pedidoId: pagamento.external_reference ?? null
  };
}

function hexParaBytes(hex) {
  if (hex.length % 2 !== 0) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}

// Comparacao de tempo constante: uma comparacao comum vaza, pelo tempo que
// leva, quantos bytes iniciais o atacante acertou.
function iguaisEmTempoConstante(a, b) {
  if (a.length !== b.length) return false;

  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a[i] ^ b[i];
  return diferenca === 0;
}

/**
 * Confere a assinatura da notificacao. Sem isso, qualquer um envia um POST
 * dizendo "pagamento aprovado" e ganha creditos de graca.
 *
 * O Mercado Pago manda `x-signature: ts=<ts>,v1=<hmac>` e assina o texto
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com o segredo do webhook.
 */
export async function assinaturaValida(env, request, dataId) {
  const segredo = env.MP_WEBHOOK_SECRET;
  if (!segredo) return false;

  const cabecalho = request.headers.get('x-signature') || '';
  const requestId = request.headers.get('x-request-id') || '';

  let ts = '';
  let assinatura = '';
  for (const parte of cabecalho.split(',')) {
    const [chave, valor] = parte.split('=', 2);
    if (chave?.trim() === 'ts') ts = valor?.trim() ?? '';
    if (chave?.trim() === 'v1') assinatura = valor?.trim() ?? '';
  }

  if (!ts || !assinatura || !dataId) return false;

  const esperada = hexParaBytes(assinatura);
  if (!esperada) return false;

  // O manifesto usa o data.id em minusculas e omite os campos que nao vieram.
  let manifesto = `id:${String(dataId).toLowerCase()};`;
  if (requestId) manifesto += `request-id:${requestId};`;
  manifesto += `ts:${ts};`;

  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const calculada = new Uint8Array(
    await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(manifesto))
  );

  return iguaisEmTempoConstante(calculada, esperada);
}
