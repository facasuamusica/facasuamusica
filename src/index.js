import { MurekaError, gerarLetra, gerarMusica, consultarMusica, consultarSaldo } from './mureka.js';
import {
  MercadoPagoError,
  PACOTES,
  assinaturaValida,
  consultarPagamento,
  criarPreferencia
} from './mercadopago.js';
import { empurrarFila } from './fila.js';
import * as db from './db.js';

// O estudio interno (/site/estudio) falha fechado: sem o segredo
// APP_ACCESS_TOKEN as rotas de teste nem respondem. As rotas de cliente nao
// usam esse portao — quem autoriza la e o pagamento.
function autorizado(request, env) {
  const esperado = env.APP_ACCESS_TOKEN;
  if (!esperado) return false;

  const cabecalho = request.headers.get('Authorization') || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : '';

  return token.length === esperado.length && timingSafeEqual(token, esperado);
}

function timingSafeEqual(a, b) {
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diferenca === 0;
}

async function lerJson(request) {
  try {
    return await request.json();
  } catch {
    throw new MurekaError('Corpo da requisicao precisa ser JSON valido.', 400);
  }
}

function erro(mensagem, status) {
  return Response.json({ error: mensagem }, { status });
}

// ---------- compra ----------

function textoLimpo(valor, max) {
  return typeof valor === 'string' ? valor.trim().slice(0, max) : '';
}

async function criarPedido(request, env, url) {
  const { nome, email, whatsapp, pacote } = await lerJson(request);

  const dados = {
    nome: textoLimpo(nome, 120),
    email: textoLimpo(email, 160),
    whatsapp: textoLimpo(whatsapp, 40)
  };

  if (!dados.nome || !dados.email || !dados.whatsapp) {
    return erro('Informe nome, e-mail e WhatsApp.', 400);
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dados.email)) {
    return erro('E-mail invalido.', 400);
  }

  const item = PACOTES[pacote];
  if (!item) {
    return erro('Pacote invalido.', 400);
  }

  const id = db.novoId();

  // O valor vem do catalogo do servidor, nunca do corpo da requisicao.
  await db.criarPedido(env, {
    id,
    ...dados,
    pacote,
    creditos: item.creditos,
    valorCentavos: item.valorCentavos
  });

  const preferencia = await criarPreferencia(env, {
    pedidoId: id,
    pacote,
    nome: dados.nome,
    email: dados.email,
    origem: url.origin
  });

  await db.anotarPreferencia(env, id, preferencia.id);

  return Response.json(
    { pedidoId: id, checkoutUrl: preferencia.checkoutUrl, acompanhe: `/pedido/${id}` },
    { status: 201 }
  );
}

// ---------- webhook ----------

const STATUS_MP = {
  approved: 'pago',
  rejected: 'recusado',
  cancelled: 'cancelado',
  refunded: 'estornado',
  charged_back: 'estornado'
};

async function receberWebhook(request, env) {
  const corpo = await lerJson(request).catch(() => ({}));
  const dataId = corpo?.data?.id ?? new URL(request.url).searchParams.get('data.id');

  // Falha fechado antes de qualquer outra coisa: sem assinatura valida, nao
  // ha motivo para consultar o Mercado Pago nem tocar no banco.
  if (!(await assinaturaValida(env, request, dataId))) {
    return erro('Assinatura invalida.', 401);
  }

  if (corpo?.type && corpo.type !== 'payment') {
    return Response.json({ ignorado: corpo.type });
  }

  // O corpo da notificacao nao e fonte de verdade sobre valor nem status:
  // so o id serve, e o resto vem da API.
  const pagamento = await consultarPagamento(env, dataId);

  if (!pagamento.pedidoId) {
    return Response.json({ ignorado: 'sem external_reference' });
  }

  const novo = await db.registrarEvento(env, {
    id: `payment:${pagamento.id}:${pagamento.status}`,
    tipo: 'payment',
    pedidoId: pagamento.pedidoId
  });

  if (!novo) {
    return Response.json({ repetido: true });
  }

  const pedido = await db.buscarPedido(env, pagamento.pedidoId);
  if (!pedido) {
    return Response.json({ ignorado: 'pedido inexistente' });
  }

  const situacao = STATUS_MP[pagamento.status];

  if (situacao !== 'pago') {
    if (situacao) await db.marcarStatus(env, pedido.id, situacao);
    return Response.json({ status: situacao ?? pagamento.status });
  }

  // Confere o valor: um pagamento aprovado de R$ 1 nao libera o pacote de R$ 147.
  if (pagamento.valorCentavos !== pedido.valor_centavos) {
    console.error(
      `Valor divergente no pedido ${pedido.id}: esperado ${pedido.valor_centavos}, recebido ${pagamento.valorCentavos}`
    );
    return Response.json({ ignorado: 'valor divergente' });
  }

  await db.marcarPago(env, pedido.id, pagamento.id);
  return Response.json({ status: 'pago' });
}

// ---------- area do cliente ----------

// A fila pode falhar sem derrubar a resposta: o cron passa de novo em um
// minuto, e o cliente ve a pagina com o que ja existe.
async function empurrarSemQuebrar(env) {
  try {
    await empurrarFila(env);
  } catch (e) {
    console.error('Falha ao empurrar a fila:', e);
  }
}

async function verPedido(env, pedidoId) {
  if (!(await db.buscarPedido(env, pedidoId))) return erro('Pedido nao encontrado.', 404);

  // Quem esta olhando a pagina nao espera o relogio do cron.
  await empurrarSemQuebrar(env);

  // Relido depois da fila: ela pode ter devolvido um credito neste meio tempo.
  const pedido = await db.buscarPedido(env, pedidoId);
  if (!pedido) return erro('Pedido nao encontrado.', 404);

  const musicas = await db.musicasDoPedido(env, pedido.id);

  return Response.json({
    id: pedido.id,
    nome: pedido.nome,
    status: pedido.status,
    creditos: pedido.creditos,
    creditosUsados: pedido.creditos_usados,
    creditosRestantes: pedido.creditos - pedido.creditos_usados,
    musicas: musicas.map((m) => ({
      id: m.id,
      titulo: m.titulo,
      status: m.status,
      audio: m.audio_url,
      erro: m.erro
    }))
  });
}

async function escreverLetra(request, env, pedidoId) {
  const pedido = await db.buscarPedido(env, pedidoId);
  if (!pedido) return erro('Pedido nao encontrado.', 404);
  if (pedido.status !== 'pago') return erro('Este pedido ainda nao foi pago.', 402);
  if (pedido.creditos_usados >= pedido.creditos) return erro('Seus creditos acabaram.', 402);

  const { briefing } = await lerJson(request);
  if (!briefing?.trim()) return erro('Conte a historia da musica.', 400);

  return Response.json(await gerarLetra(env, briefing));
}

async function pedirMusica(request, env, pedidoId) {
  const pedido = await db.buscarPedido(env, pedidoId);
  if (!pedido) return erro('Pedido nao encontrado.', 404);
  if (pedido.status !== 'pago') return erro('Este pedido ainda nao foi pago.', 402);

  const corpo = await lerJson(request);
  if (!corpo?.letra?.trim()) return erro('A letra nao pode ficar vazia.', 400);

  const musicaId = await db.consumirCredito(env, pedido.id, corpo);
  if (!musicaId) return erro('Seus creditos acabaram.', 402);

  // Quem fala com a Mureka e a fila, nao esta rota. Assim o cliente nunca
  // recebe "ha outra musica sendo gerada": ele entra na fila, e a espera
  // aparece na propria pagina.
  await empurrarSemQuebrar(env);

  return Response.json({ musicaId, status: 'na_fila' }, { status: 202 });
}

// ---------- roteador ----------

async function rotearApi(request, env, url) {
  const rota = url.pathname;
  const metodo = request.method;

  if (rota === '/api/saude') {
    return Response.json({
      ok: true,
      murekaConfigurada: Boolean(env.MUREKA_API_KEY),
      geracaoLiberada: Boolean(env.APP_ACCESS_TOKEN),
      pagamentoConfigurado: Boolean(env.MP_ACCESS_TOKEN && env.MP_WEBHOOK_SECRET),
      bancoConfigurado: Boolean(env.DB)
    });
  }

  // Autenticado pela assinatura do Mercado Pago, nao pelo nosso token.
  if (rota === '/api/webhook/mercadopago' && metodo === 'POST') {
    return receberWebhook(request, env);
  }

  if (rota === '/api/pacotes' && metodo === 'GET') {
    return Response.json(
      Object.entries(PACOTES).map(([id, p]) => ({ id, creditos: p.creditos, valorCentavos: p.valorCentavos }))
    );
  }

  if (rota === '/api/pedido' && metodo === 'POST') {
    return criarPedido(request, env, url);
  }

  // O id do pedido e o proprio segredo: 128 bits, entregue so a quem comprou.
  const doPedido = rota.match(/^\/api\/pedido\/([0-9a-f]{32})(\/letra|\/musica)?$/);
  if (doPedido) {
    const [, pedidoId, sub] = doPedido;

    if (!sub && metodo === 'GET') return verPedido(env, pedidoId);
    if (sub === '/letra' && metodo === 'POST') return escreverLetra(request, env, pedidoId);
    if (sub === '/musica' && metodo === 'POST') return pedirMusica(request, env, pedidoId);
  }

  // Daqui para baixo, so o estudio interno.
  if (!autorizado(request, env)) {
    return erro('Nao autorizado.', 401);
  }

  if (rota === '/api/letra' && metodo === 'POST') {
    const { briefing } = await lerJson(request);
    if (!briefing?.trim()) return erro('Envie o briefing da musica.', 400);
    return Response.json(await gerarLetra(env, briefing));
  }

  if (rota === '/api/musica' && metodo === 'POST') {
    return Response.json(await gerarMusica(env, await lerJson(request)), { status: 202 });
  }

  const consulta = rota.match(/^\/api\/musica\/([^/]+)$/);
  if (consulta && metodo === 'GET') {
    return Response.json(await consultarMusica(env, decodeURIComponent(consulta[1])));
  }

  if (rota === '/api/saldo' && metodo === 'GET') {
    return Response.json(await consultarSaldo(env));
  }

  return erro('Endpoint nao encontrado', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await rotearApi(request, env, url);
      } catch (e) {
        if (e instanceof MurekaError || e instanceof MercadoPagoError || e instanceof db.DbError) {
          if (e.traceId) console.error(`Mureka trace_id=${e.traceId}: ${e.message}`);
          return erro(e.message, e.status);
        }

        console.error('Erro inesperado na API:', e);
        return erro('Erro interno.', 500);
      }
    }

    // A area do cliente e uma pagina so, servida para qualquer id de pedido:
    // o id vive na URL e quem o le e o navegador. Sem isso, o cliente que
    // acabou de pagar cairia num 404 ao voltar do Mercado Pago.
    if (/^\/pedido\/[0-9a-f]{32}\/?$/.test(url.pathname)) {
      // Busca a pasta, nao o index.html: o Assets redireciona o caminho
      // explicito e o cliente receberia o 307 em vez da pagina.
      return env.ASSETS.fetch(new Request(new URL('/pedido/', url), request));
    }

    return env.ASSETS.fetch(request);
  },

  // De minuto em minuto: sem isso, a musica de quem fechou a aba ficaria
  // "gerando" para sempre, porque ninguem consultaria o andamento.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      empurrarFila(env).catch((e) => console.error('Cron da fila falhou:', e))
    );
  }
};
