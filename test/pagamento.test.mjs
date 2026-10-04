// Exercita compra, webhook e consumo de credito com o Mercado Pago e a Mureka
// mockados, e um D1 falso em memoria. Nenhuma chamada real, nenhum centavo.
import worker from '../src/index.js';

const SEGREDO = 'segredo-do-webhook';
const TOKEN = 'token-interno';

// ---------- D1 falso ----------
// Entende so as instrucoes que o codigo usa; serve para exercitar as regras,
// nao para substituir o banco.
function criarDb() {
  const pedidos = new Map();
  const musicas = new Map();
  const eventos = new Set();

  const executar = (sql, args) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO pedidos')) {
      const [id, nome, email, whatsapp, pacote, creditos, valor_centavos, criado_em] = args;
      pedidos.set(id, {
        id, nome, email, whatsapp, pacote, creditos, valor_centavos, criado_em,
        creditos_usados: 0, status: 'pendente', mp_preference_id: null, mp_payment_id: null, pago_em: null
      });
      return { meta: { changes: 1 } };
    }

    if (s.startsWith('SELECT * FROM pedidos')) return pedidos.get(args[0]) ?? null;

    if (s.includes('SET mp_preference_id')) {
      const p = pedidos.get(args[1]);
      if (p) p.mp_preference_id = args[0];
      return { meta: { changes: p ? 1 : 0 } };
    }

    if (s.includes("SET status = 'pago'")) {
      const p = pedidos.get(args[2]);
      if (!p || p.status !== 'pendente') return { meta: { changes: 0 } };
      Object.assign(p, { status: 'pago', mp_payment_id: args[0], pago_em: args[1] });
      return { meta: { changes: 1 } };
    }

    if (s.startsWith('UPDATE pedidos SET status = ?')) {
      const p = pedidos.get(args[1]);
      if (!p || p.status !== 'pendente') return { meta: { changes: 0 } };
      p.status = args[0];
      return { meta: { changes: 1 } };
    }

    if (s.startsWith('INSERT INTO eventos_webhook')) {
      if (eventos.has(args[0])) throw new Error('UNIQUE constraint failed: eventos_webhook.id');
      eventos.add(args[0]);
      return { meta: { changes: 1 } };
    }

    if (s.includes('creditos_usados = creditos_usados + 1')) {
      const p = pedidos.get(args[0]);
      if (!p || p.status !== 'pago' || p.creditos_usados >= p.creditos) return { meta: { changes: 0 } };
      p.creditos_usados++;
      return { meta: { changes: 1 } };
    }

    if (s.includes('creditos_usados = creditos_usados - 1')) {
      const p = pedidos.get(args[0]);
      if (p && p.creditos_usados > 0) p.creditos_usados--;
      return { meta: { changes: 1 } };
    }

    if (s.startsWith('INSERT INTO musicas')) {
      const [id, pedido_id, briefing, titulo, letra, estilo, voz, criado_em] = args;
      const p = pedidos.get(pedido_id);
      if (!p || p.status !== 'pago') return { meta: { changes: 0 } };
      musicas.set(id, {
        id, pedido_id, briefing, titulo, letra, estilo, voz, criado_em,
        status: 'na_fila', mureka_task_id: null, audio_url: null, erro: null, concluido_em: null,
        tentativas: 0, credito_devolvido: 0
      });
      return { meta: { changes: 1 } };
    }

    // --- fila ---

    if (s.includes("WHERE status = 'gerando' AND mureka_task_id IS NOT NULL")) {
      return { results: [...musicas.values()].filter((m) => m.status === 'gerando' && m.mureka_task_id) };
    }

    if (s.includes("WHERE status = 'na_fila' ORDER BY criado_em")) {
      return [...musicas.values()].filter((m) => m.status === 'na_fila')
        .sort((a, b) => a.criado_em - b.criado_em)[0] ?? null;
    }

    if (s.includes("SET status = 'gerando' WHERE id = ? AND status = 'na_fila'")) {
      const m = musicas.get(args[0]);
      if (!m || m.status !== 'na_fila') return { meta: { changes: 0 } };
      m.status = 'gerando';
      return { meta: { changes: 1 } };
    }

    if (s.includes("SET status = 'na_fila', mureka_task_id = NULL")) {
      const m = musicas.get(args[0]);
      if (m) Object.assign(m, { status: 'na_fila', mureka_task_id: null, tentativas: m.tentativas + 1 });
      return { meta: { changes: 1 } };
    }

    if (s.includes('credito_devolvido = 1')) {
      const m = musicas.get(args[2]);
      if (!m || m.credito_devolvido === 1) return { meta: { changes: 0 } };
      Object.assign(m, { status: 'falhou', erro: args[0], concluido_em: args[1], credito_devolvido: 1 });
      return { meta: { changes: 1 } };
    }

    if (s.includes('SET mureka_task_id')) {
      const m = musicas.get(args[1]);
      if (m) Object.assign(m, { mureka_task_id: args[0], status: 'gerando' });
      return { meta: { changes: 1 } };
    }

    if (s.includes("SET status = 'pronta'")) {
      const m = musicas.get(args[3]);
      if (m) Object.assign(m, { status: 'pronta', audio_url: args[0], concluido_em: args[2] });
      return { meta: { changes: 1 } };
    }

    if (s.includes("SET status = 'falhou'")) {
      const m = musicas.get(args[2]);
      if (m) Object.assign(m, { status: 'falhou', erro: args[0], concluido_em: args[1] });
      return { meta: { changes: 1 } };
    }

    if (s.includes('COUNT(*) AS n FROM musicas')) {
      return { n: [...musicas.values()].filter((m) => m.status === 'gerando').length };
    }

    if (s.includes('FROM musicas WHERE pedido_id')) {
      return { results: [...musicas.values()].filter((m) => m.pedido_id === args[0]) };
    }

    if (s.startsWith('SELECT * FROM musicas WHERE id')) return musicas.get(args[0]) ?? null;

    throw new Error('SQL nao previsto no teste: ' + s.slice(0, 70));
  };

  // Como no D1 real, da para executar com ou sem bind().
  const comArgs = (sql, args) => ({
    run: async () => executar(sql, args),
    first: async () => executar(sql, args),
    all: async () => executar(sql, args)
  });

  const prepare = (sql) => ({
    bind: (...args) => comArgs(sql, args),
    ...comArgs(sql, [])
  });

  return {
    prepare,
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    _pedidos: pedidos,
    _musicas: musicas
  };
}

// ---------- assinatura do Mercado Pago ----------
async function assinar(dataId, requestId, ts, segredo = SEGREDO) {
  const manifesto = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(manifesto)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- ambiente ----------
let respostasMp = {};
let respostasMureka = {};
let chamadas = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  chamadas.push({ url: u.href, init });
  const fonte = u.host.includes('mercadopago') ? respostasMp : respostasMureka;
  const r = fonte[u.pathname];
  if (!r) return new Response(JSON.stringify({ message: 'nao mockado' }), { status: 404 });
  return r();
};

function ambiente(db) {
  return {
    DB: db,
    MUREKA_API_KEY: 'chave-mureka',
    APP_ACCESS_TOKEN: TOKEN,
    MP_ACCESS_TOKEN: 'TEST-token',
    MP_WEBHOOK_SECRET: SEGREDO,
    ASSETS: { fetch: () => new Response('asset') }
  };
}

const req = (caminho, { method = 'GET', body, headers = {} } = {}) =>
  new Request(`https://facasuamusica.com.br${caminho}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });

let falhas = 0;
function checa(nome, ok, detalhe = '') {
  if (ok) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome} ${detalhe}`); }
}

// ================= compra =================
console.log('\nCriacao do pedido');
let db = criarDb();
let env = ambiente(db);
respostasMp['/checkout/preferences'] = () =>
  new Response(JSON.stringify({ id: 'pref-1', init_point: 'https://mp/checkout/pref-1' }), { status: 200 });

let r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'Marise', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p3' } }), env);
let corpo = await r.json();
checa('cria pedido e devolve 201', r.status === 201, `status=${r.status}`);
checa('devolve link de checkout', corpo.checkoutUrl === 'https://mp/checkout/pref-1');
const PEDIDO = corpo.pedidoId;
checa('id do pedido tem 32 hex (128 bits)', /^[0-9a-f]{32}$/.test(PEDIDO), PEDIDO);
checa('grava valor do catalogo, nao do cliente', db._pedidos.get(PEDIDO).valor_centavos === 8700);
checa('grava creditos do pacote', db._pedidos.get(PEDIDO).creditos === 3);
checa('pedido nasce pendente', db._pedidos.get(PEDIDO).status === 'pendente');

r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p3', valorCentavos: 1 } }), env);
corpo = await r.json();
checa('preco enviado pelo cliente e ignorado', db._pedidos.get(corpo.pedidoId).valor_centavos === 8700);

r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'nao-e-email', whatsapp: '11912345678', pacote: 'p1' } }), env);
checa('recusa e-mail invalido', r.status === 400);

r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: '11912345678', pacote: 'inexistente' } }), env);
checa('recusa pacote inexistente', r.status === 400);

r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: '', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p1' } }), env);
checa('exige nome, e-mail e whatsapp', r.status === 400);

console.log('\nWhatsApp: guardado pronto para enviar');
var formatos = [
  ['11912345678',       '5511912345678', 'so digitos'],
  ['(11) 91234-5678',   '5511912345678', 'com parenteses e traco'],
  ['+55 11 91234-5678', '5511912345678', 'com codigo do pais'],
  ['011 91234 5678',    '5511912345678', 'com o zero do DDD'],
  ['21 99876-5432',     '5521998765432', 'outro DDD']
];
for (const [digitado, esperado, descricao] of formatos) {
  const resp = await worker.fetch(req('/api/pedido', {
    method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: digitado, pacote: 'p1' }
  }), env);
  const c = await resp.json();
  const guardado = db._pedidos.get(c.pedidoId)?.whatsapp;
  checa('normaliza ' + descricao, guardado === esperado, `${digitado} -> ${guardado}`);
}

var invalidos = [
  ['1191234567',   'sem o nono digito'],
  ['23912345678',  'DDD que nao existe (23)'],
  ['11812345678',  'fixo, nao celular'],
  ['912345678',    'sem DDD'],
  ['abc',          'texto']
];
for (const [digitado, descricao] of invalidos) {
  const resp = await worker.fetch(req('/api/pedido', {
    method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: digitado, pacote: 'p1' }
  }), env);
  checa('recusa ' + descricao, resp.status === 400, `${digitado} -> status ${resp.status}`);
}

// ================= webhook =================
console.log('\nWebhook: assinatura');
const TS = '1700000000';
const RID = 'req-1';
respostasMp['/v1/payments/pay-1'] = () =>
  new Response(JSON.stringify({ id: 'pay-1', status: 'approved', transaction_amount: 87, external_reference: PEDIDO }), { status: 200 });

r = await worker.fetch(req('/api/webhook/mercadopago', { method: 'POST', body: { type: 'payment', data: { id: 'pay-1' } } }), env);
checa('sem assinatura devolve 401', r.status === 401, `status=${r.status}`);
checa('pedido continua pendente', db._pedidos.get(PEDIDO).status === 'pendente');

r = await worker.fetch(req('/api/webhook/mercadopago', {
  method: 'POST', body: { type: 'payment', data: { id: 'pay-1' } },
  headers: { 'x-signature': `ts=${TS},v1=${'0'.repeat(64)}`, 'x-request-id': RID }
}), env);
checa('assinatura forjada devolve 401', r.status === 401);
checa('pedido continua pendente apos forja', db._pedidos.get(PEDIDO).status === 'pendente');

const assinaturaErrada = await assinar('pay-1', RID, TS, 'outro-segredo');
r = await worker.fetch(req('/api/webhook/mercadopago', {
  method: 'POST', body: { type: 'payment', data: { id: 'pay-1' } },
  headers: { 'x-signature': `ts=${TS},v1=${assinaturaErrada}`, 'x-request-id': RID }
}), env);
checa('assinatura de outro segredo devolve 401', r.status === 401);

chamadas = [];
await worker.fetch(req('/api/webhook/mercadopago', { method: 'POST', body: { type: 'payment', data: { id: 'pay-1' } } }), env);
checa('falha fechado antes de consultar o Mercado Pago', chamadas.length === 0, `${chamadas.length} chamadas`);

console.log('\nWebhook: pagamento aprovado');
const boa = await assinar('pay-1', RID, TS);
const webhookValido = () => req('/api/webhook/mercadopago', {
  method: 'POST', body: { type: 'payment', data: { id: 'pay-1' } },
  headers: { 'x-signature': `ts=${TS},v1=${boa}`, 'x-request-id': RID }
});

r = await worker.fetch(webhookValido(), env);
corpo = await r.json();
checa('assinatura valida e aceita', r.status === 200 && corpo.status === 'pago', JSON.stringify(corpo));
checa('pedido fica pago', db._pedidos.get(PEDIDO).status === 'pago');
checa('guarda o id do pagamento', db._pedidos.get(PEDIDO).mp_payment_id === 'pay-1');

r = await worker.fetch(webhookValido(), env);
corpo = await r.json();
checa('reenvio e reconhecido como repetido', corpo.repetido === true, JSON.stringify(corpo));
checa('creditos nao dobram no reenvio', db._pedidos.get(PEDIDO).creditos === 3);

console.log('\nWebhook: valor divergente');
db = criarDb(); env = ambiente(db);
r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p7' } }), env);
const CARO = (await r.json()).pedidoId;
respostasMp['/v1/payments/pay-2'] = () =>
  new Response(JSON.stringify({ id: 'pay-2', status: 'approved', transaction_amount: 1, external_reference: CARO }), { status: 200 });
const boa2 = await assinar('pay-2', RID, TS);
r = await worker.fetch(req('/api/webhook/mercadopago', {
  method: 'POST', body: { type: 'payment', data: { id: 'pay-2' } },
  headers: { 'x-signature': `ts=${TS},v1=${boa2}`, 'x-request-id': RID }
}), env);
corpo = await r.json();
checa('pagamento de R$ 1 nao libera pacote de R$ 147', db._pedidos.get(CARO).status !== 'pago', JSON.stringify(corpo));

// ================= area do cliente =================
console.log('\nArea do cliente');
db = criarDb(); env = ambiente(db);
r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p1' } }), env);
const P1 = (await r.json()).pedidoId;

r = await worker.fetch(req(`/api/pedido/${P1}/musica`, { method: 'POST', body: { letra: 'oi' } }), env);
checa('pedido nao pago nao gera musica', r.status === 402, `status=${r.status}`);

r = await worker.fetch(req(`/api/pedido/${P1}/letra`, { method: 'POST', body: { briefing: 'oi' } }), env);
checa('pedido nao pago nao gera letra', r.status === 402);

r = await worker.fetch(req('/api/pedido/naoexiste/'), env);
checa('id fora do formato nao chega ao banco', r.status === 401 || r.status === 404);

db._pedidos.get(P1).status = 'pago';

respostasMureka['/v1/song/generate'] = () =>
  new Response(JSON.stringify({ id: 'task-9', status: 'preparing' }), { status: 200 });
respostasMureka['/v1/song/query/task-9'] = () =>
  new Response(JSON.stringify({ id: 'task-9', status: 'preparing' }), { status: 200 });

r = await worker.fetch(req(`/api/pedido/${P1}/musica`, { method: 'POST', body: { letra: '[Verse]\noi' } }), env);
checa('pedido pago aceita o pedido de musica (202)', r.status === 202, `status=${r.status}`);
checa('consome um credito', db._pedidos.get(P1).creditos_usados === 1);
checa('a fila enviou a musica a Mureka', [...db._musicas.values()][0].mureka_task_id === 'task-9');

// Sem credito sobrando (o pacote era de 1).
r = await worker.fetch(req(`/api/pedido/${P1}/musica`, { method: 'POST', body: { letra: 'mais uma' } }), env);
checa('sem credito devolve 402, nao 409', r.status === 402, `status=${r.status}`);

console.log('\nFila: espera a vez em vez de recusar');
db = criarDb(); env = ambiente(db);
r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p3' } }), env);
const P3 = (await r.json()).pedidoId;
db._pedidos.get(P3).status = 'pago';

await worker.fetch(req(`/api/pedido/${P3}/musica`, { method: 'POST', body: { letra: 'primeira' } }), env);
r = await worker.fetch(req(`/api/pedido/${P3}/musica`, { method: 'POST', body: { letra: 'segunda' } }), env);
checa('segunda musica e aceita, nao recusada', r.status === 202, `status=${r.status}`);

let estados = [...db._musicas.values()].map((m) => m.status).sort();
checa('uma gerando e uma esperando a vez', estados.join(',') === 'gerando,na_fila', estados.join(','));
checa('so uma tarefa aberta na Mureka (limite do plano)',
  [...db._musicas.values()].filter((m) => m.mureka_task_id).length === 1);

console.log('\nFalha nunca custa credito ao cliente');
db = criarDb(); env = ambiente(db);
r = await worker.fetch(req('/api/pedido', { method: 'POST', body: { nome: 'M', email: 'x@y.com', whatsapp: '11912345678', pacote: 'p1' } }), env);
const P2 = (await r.json()).pedidoId;
db._pedidos.get(P2).status = 'pago';
respostasMureka['/v1/song/generate'] = () =>
  new Response(JSON.stringify({ message: 'You exceeded your current quota' }), { status: 429 });

r = await worker.fetch(req(`/api/pedido/${P2}/musica`, { method: 'POST', body: { letra: 'oi' } }), env);
checa('a recusa da Mureka nao quebra a resposta ao cliente', r.status === 202, `status=${r.status}`);
checa('primeira falha nao desiste: volta para a fila', [...db._musicas.values()][0].status === 'na_fila');
checa('credito ainda reservado durante as tentativas', db._pedidos.get(P2).creditos_usados === 1);

// Mais duas passadas da fila: na terceira ela desiste.
await worker.fetch(req(`/api/pedido/${P2}`), env);
await worker.fetch(req(`/api/pedido/${P2}`), env);

const falhada = [...db._musicas.values()][0];
checa('desiste depois de tres tentativas', falhada.status === 'falhou', `status=${falhada.status} tentativas=${falhada.tentativas}`);
checa('o credito volta ao desistir', db._pedidos.get(P2).creditos_usados === 0, `usados=${db._pedidos.get(P2).creditos_usados}`);

// O cron pode passar de novo sobre a mesma musica.
await worker.fetch(req(`/api/pedido/${P2}`), env);
checa('credito nao e devolvido duas vezes', db._pedidos.get(P2).creditos_usados === 0, `usados=${db._pedidos.get(P2).creditos_usados}`);

corpo = await (await worker.fetch(req(`/api/pedido/${P2}`), env)).json();
checa('o cliente volta a ter o credito disponivel', corpo.creditosRestantes === 1, JSON.stringify(corpo.creditosRestantes));

console.log('\nDiagnostico');
r = await worker.fetch(req('/api/saude'), env);
corpo = await r.json();
checa('/api/saude informa pagamento e banco', corpo.pagamentoConfigurado === true && corpo.bancoConfigurado === true, JSON.stringify(corpo));

r = await worker.fetch(req('/api/pacotes'), env);
corpo = await r.json();
checa('/api/pacotes publica os precos do servidor', corpo.find((p) => p.id === 'p7')?.valorCentavos === 14700);

console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
