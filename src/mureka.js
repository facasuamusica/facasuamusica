// Adaptador da Mureka — unico ponto do codigo que conhece a API do motor de
// audio. Se um dia trocarmos de fornecedor, e aqui que a troca acontece.
// Documentacao: https://platform.mureka.ai/docs/

const API_BASE = 'https://api.mureka.ai';
const TIMEOUT_MS = 30000;

// Modelo padrao. "auto" acompanha a versao mais recente do modelo regular.
const MODELO_PADRAO = 'auto';

const MODELOS = ['auto', 'mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9', 'mureka-9.5'];
const VOZES = ['female', 'male'];

// Status que a Mureka pode devolver numa tarefa.
const STATUS_EM_ANDAMENTO = ['preparing', 'queued', 'running', 'streaming'];
const STATUS_FINAL = ['succeeded', 'failed', 'timeouted', 'cancelled'];

export class MurekaError extends Error {
  constructor(mensagem, status = 502, traceId = null) {
    super(mensagem);
    this.name = 'MurekaError';
    this.status = status;
    this.traceId = traceId;
  }
}

async function chamar(env, caminho, { method = 'GET', body } = {}) {
  const chave = env.MUREKA_API_KEY;

  if (!chave) {
    throw new MurekaError('MUREKA_API_KEY nao configurada no Worker.', 503);
  }

  const headers = { Authorization: `Bearer ${chave}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

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
    throw new MurekaError(
      expirou ? 'A Mureka demorou demais para responder.' : 'Nao foi possivel falar com a Mureka.',
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
    // A Mureka devolve o detalhe em formatos diferentes conforme o erro.
    const detalhe =
      dados?.error?.message || dados?.message || dados?.error || `HTTP ${resposta.status}`;

    // 401/403 sao erro nosso de configuracao, nao do visitante; 429 e limite
    // de uso e vale repassar para o cliente poder tentar de novo.
    const status = resposta.status === 429 ? 429 : resposta.status >= 500 ? 502 : 500;

    throw new MurekaError(`Mureka respondeu com erro: ${detalhe}`, status, dados?.trace_id ?? null);
  }

  return dados;
}

// Converte a tarefa da Mureka no formato que a nossa interface consome, sem
// vazar campos internos do fornecedor.
function normalizarTarefa(tarefa) {
  const status = tarefa?.status ?? 'preparing';

  return {
    id: tarefa?.id ?? null,
    status,
    concluida: STATUS_FINAL.includes(status),
    sucesso: status === 'succeeded',
    erro: tarefa?.failed_reason ?? null,
    criadaEm: tarefa?.created_at ?? null,
    concluidaEm: tarefa?.finished_at ?? null,
    musicas: (tarefa?.choices ?? []).map((escolha) => ({
      id: escolha?.id ?? null,
      // Os links da Mureka expiram em 30 dias: antes do lancamento e preciso
      // copiar o audio para armazenamento nosso (R2) na hora da entrega.
      audio: escolha?.url ?? null,
      audioFlac: escolha?.flac_url ?? null,
      audioWav: escolha?.wav_url ?? null,
      streaming: escolha?.stream_url ?? null,
      duracaoMs: escolha?.duration ?? null
    }))
  };
}

export function emAndamento(status) {
  return STATUS_EM_ANDAMENTO.includes(status);
}

/**
 * Gera titulo e letra a partir de um briefing em texto livre.
 * @returns {Promise<{titulo: string, letra: string}>}
 */
export async function gerarLetra(env, prompt) {
  const dados = await chamar(env, '/v1/lyrics/generate', {
    method: 'POST',
    body: { prompt }
  });

  return {
    titulo: dados?.title ?? '',
    letra: dados?.lyrics ?? ''
  };
}

/**
 * Abre a tarefa assincrona de geracao da musica. A letra e obrigatoria; o
 * prompt descreve estilo, andamento e timbre ("mpb, romantica, voz feminina").
 */
export async function gerarMusica(env, { letra, estilo, voz, modelo, quantidade = 2 }) {
  if (!letra?.trim()) {
    throw new MurekaError('A letra e obrigatoria para gerar a musica.', 400);
  }

  if (letra.length > 5000) {
    throw new MurekaError('A letra passa do limite de 5000 caracteres da Mureka.', 400);
  }

  if (estilo && estilo.length > 1024) {
    throw new MurekaError('A descricao de estilo passa do limite de 1024 caracteres.', 400);
  }

  if (modelo && !MODELOS.includes(modelo)) {
    throw new MurekaError(`Modelo invalido. Use um de: ${MODELOS.join(', ')}.`, 400);
  }

  if (voz && !VOZES.includes(voz)) {
    throw new MurekaError('Voz invalida. Use "female" ou "male".', 400);
  }

  // A Mureka cobra por musica gerada, entao o teto de 3 do fornecedor fica
  // limitado a 2 aqui para o custo por pedido nao escapar.
  const n = Math.min(Math.max(Number(quantidade) || 2, 1), 2);

  const corpo = { lyrics: letra, model: modelo || MODELO_PADRAO, n };
  if (estilo) corpo.prompt = estilo;
  if (voz) corpo.gender = voz;

  const tarefa = await chamar(env, '/v1/song/generate', { method: 'POST', body: corpo });
  return normalizarTarefa(tarefa);
}

/** Consulta o andamento de uma tarefa aberta por gerarMusica. */
export async function consultarMusica(env, taskId) {
  if (!taskId) {
    throw new MurekaError('Informe o id da tarefa.', 400);
  }

  const tarefa = await chamar(env, `/v1/song/query/${encodeURIComponent(taskId)}`);
  return normalizarTarefa(tarefa);
}

/** Saldo da conta na Mureka — util para monitorar credito antes de vender. */
export async function consultarSaldo(env) {
  return chamar(env, '/v1/account/billing');
}
