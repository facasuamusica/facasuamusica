// Exercita as rotas do Worker com a Mureka mockada — nenhuma chamada real,
// nenhum credito gasto. Rodar com: npm test
import worker from '../src/index.js';

const TOKEN = 'token-de-teste';
const env = { MUREKA_API_KEY: 'chave-falsa', APP_ACCESS_TOKEN: TOKEN, ASSETS: { fetch: () => new Response('asset') } };

let ultimaChamada = null;
const respostas = new Map();
globalThis.fetch = async (url, init = {}) => {
  ultimaChamada = { url: String(url), init };
  const resposta = respostas.get(new URL(String(url)).pathname);
  if (!resposta) return new Response(JSON.stringify({ message: 'nao mockado' }), { status: 404 });
  return resposta();
};

const req = (caminho, { method = 'GET', body, token = TOKEN } = {}) =>
  new Request(`https://facasuamusica.com.br${caminho}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });

let falhas = 0;
function checa(nome, condicao, detalhe = '') {
  if (condicao) {
    console.log(`  ok   ${nome}`);
  } else {
    falhas++;
    console.log(`  FALHA ${nome} ${detalhe}`);
  }
}

// --- portao de acesso ---
console.log('\nPortao de acesso');
let r = await worker.fetch(req('/api/musica', { method: 'POST', body: {}, token: null }), env);
checa('sem token devolve 401', r.status === 401);

r = await worker.fetch(req('/api/musica', { method: 'POST', body: {}, token: 'errado' }), env);
checa('token errado devolve 401', r.status === 401);

r = await worker.fetch(req('/api/musica', { method: 'POST', body: {} }), { ...env, APP_ACCESS_TOKEN: undefined });
checa('sem APP_ACCESS_TOKEN falha fechado', r.status === 401);

r = await worker.fetch(req('/api/saude', { token: null }), env);
let corpo = await r.json();
checa('/api/saude e publica', r.status === 200 && corpo.murekaConfigurada === true && corpo.geracaoLiberada === true);

// --- validacao de entrada ---
console.log('\nValidacao de entrada');
r = await worker.fetch(req('/api/musica', { method: 'POST', body: { letra: '' } }), env);
corpo = await r.json();
checa('letra vazia devolve 400', r.status === 400, JSON.stringify(corpo));

r = await worker.fetch(req('/api/musica', { method: 'POST', body: { letra: 'x'.repeat(5001) } }), env);
checa('letra acima de 5000 devolve 400', r.status === 400);

r = await worker.fetch(req('/api/musica', { method: 'POST', body: { letra: 'ola', modelo: 'inexistente' } }), env);
checa('modelo invalido devolve 400', r.status === 400);

r = await worker.fetch(req('/api/musica', { method: 'POST', body: { letra: 'ola', voz: 'outro' } }), env);
checa('voz invalida devolve 400', r.status === 400);

// --- geracao feliz ---
console.log('\nGeracao');
respostas.set('/v1/song/generate', () =>
  new Response(JSON.stringify({ id: 'task-1', status: 'preparing', created_at: 1 }), { status: 200 }));

r = await worker.fetch(
  req('/api/musica', { method: 'POST', body: { letra: '[Verse]\nOi', estilo: 'mpb romantica', voz: 'female', quantidade: 9 } }),
  env
);
corpo = await r.json();
const enviado = JSON.parse(ultimaChamada.init.body);
checa('devolve 202', r.status === 202, `status=${r.status}`);
checa('repassa id e status', corpo.id === 'task-1' && corpo.status === 'preparing');
checa('envia Authorization Bearer', ultimaChamada.init.headers.Authorization === 'Bearer chave-falsa');
checa('mapeia letra->lyrics e estilo->prompt', enviado.lyrics === '[Verse]\nOi' && enviado.prompt === 'mpb romantica');
checa('mapeia voz->gender', enviado.gender === 'female');
checa('modelo padrao auto', enviado.model === 'auto');
checa('limita quantidade a 2', enviado.n === 2, `n=${enviado.n}`);

// --- consulta concluida ---
console.log('\nConsulta');
respostas.set('/v1/song/query/task-1', () =>
  new Response(JSON.stringify({
    id: 'task-1',
    status: 'succeeded',
    finished_at: 9,
    choices: [{ index: 0, id: 'song-a', url: 'https://cdn/a.mp3', flac_url: 'https://cdn/a.flac', duration: 180000 }]
  }), { status: 200 }));

r = await worker.fetch(req('/api/musica/task-1'), env);
corpo = await r.json();
checa('status succeeded', corpo.status === 'succeeded' && corpo.sucesso === true && corpo.concluida === true);
checa('mapeia choices->musicas', corpo.musicas.length === 1 && corpo.musicas[0].audio === 'https://cdn/a.mp3');
checa('mapeia duration->duracaoMs', corpo.musicas[0].duracaoMs === 180000);

// --- erros da Mureka ---
console.log('\nErros da Mureka');
respostas.set('/v1/song/query/erro', () =>
  new Response(JSON.stringify({ message: 'saldo insuficiente', trace_id: 'tr-1' }), { status: 402 }));
r = await worker.fetch(req('/api/musica/erro'), env);
corpo = await r.json();
checa('erro 4xx da Mureka nao vira 200', r.status !== 200, `status=${r.status}`);
checa('mensagem tratada chega ao cliente', /saldo insuficiente/.test(corpo.error), JSON.stringify(corpo));
checa('trace_id nao vaza para o cliente', !JSON.stringify(corpo).includes('tr-1'));

respostas.set('/v1/song/query/limite', () => new Response(JSON.stringify({ message: 'rate limit' }), { status: 429 }));
r = await worker.fetch(req('/api/musica/limite'), env);
checa('429 e repassado como 429', r.status === 429, `status=${r.status}`);

// --- chave ausente ---
console.log('\nConfiguracao');
r = await worker.fetch(req('/api/musica', { method: 'POST', body: { letra: 'ola' } }), { ...env, MUREKA_API_KEY: undefined });
checa('sem MUREKA_API_KEY devolve 503', r.status === 503, `status=${r.status}`);

// --- json invalido ---
r = await worker.fetch(
  new Request('https://facasuamusica.com.br/api/musica', {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: 'nao-e-json'
  }), env);
checa('json invalido devolve 400', r.status === 400);

// --- assets intocados ---
r = await worker.fetch(new Request('https://facasuamusica.com.br/site'), env);
checa('rota nao-/api/ vai para ASSETS', await r.text() === 'asset');

console.log(falhas === 0 ? '\nTodos os testes passaram.' : `\n${falhas} teste(s) falharam.`);
process.exit(falhas === 0 ? 0 : 1);
