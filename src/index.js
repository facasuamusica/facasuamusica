import { MurekaError, gerarLetra, gerarMusica, consultarMusica, consultarSaldo } from './mureka.js';

// Enquanto o checkout do Mercado Pago e o controle de creditos nao existem,
// nada que gaste credito da Mureka pode ficar aberto na internet: qualquer
// visitante esvaziaria o saldo. Por isso o portao falha fechado — sem o
// segredo APP_ACCESS_TOKEN configurado, as rotas de geracao nem respondem.
function autorizado(request, env) {
  const esperado = env.APP_ACCESS_TOKEN;
  if (!esperado) return false;

  const cabecalho = request.headers.get('Authorization') || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : '';

  return token.length === esperado.length && timingSafeEqual(token, esperado);
}

// Comparacao de tempo constante para o token nao vazar caractere a caractere.
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

async function rotearApi(request, env, url) {
  const rota = url.pathname;

  if (rota === '/api/saude') {
    return Response.json({
      ok: true,
      murekaConfigurada: Boolean(env.MUREKA_API_KEY),
      geracaoLiberada: Boolean(env.APP_ACCESS_TOKEN)
    });
  }

  if (!autorizado(request, env)) {
    return Response.json({ error: 'Nao autorizado.' }, { status: 401 });
  }

  if (rota === '/api/letra' && request.method === 'POST') {
    const { briefing } = await lerJson(request);

    if (!briefing?.trim()) {
      return Response.json({ error: 'Envie o briefing da musica.' }, { status: 400 });
    }

    return Response.json(await gerarLetra(env, briefing));
  }

  if (rota === '/api/musica' && request.method === 'POST') {
    const corpo = await lerJson(request);
    return Response.json(await gerarMusica(env, corpo), { status: 202 });
  }

  const consulta = rota.match(/^\/api\/musica\/([^/]+)$/);
  if (consulta && request.method === 'GET') {
    return Response.json(await consultarMusica(env, decodeURIComponent(consulta[1])));
  }

  if (rota === '/api/saldo' && request.method === 'GET') {
    return Response.json(await consultarSaldo(env));
  }

  return Response.json({ error: 'Endpoint nao encontrado' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await rotearApi(request, env, url);
      } catch (erro) {
        if (erro instanceof MurekaError) {
          // O trace_id fica so no log; o cliente recebe a mensagem tratada.
          if (erro.traceId) console.error(`Mureka trace_id=${erro.traceId}: ${erro.message}`);
          return Response.json({ error: erro.message }, { status: erro.status });
        }

        console.error('Erro inesperado na API:', erro);
        return Response.json({ error: 'Erro interno.' }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
