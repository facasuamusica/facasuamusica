// A fila de geracao.
//
// O plano da Mureka permite uma musica por vez, entao os pedidos esperam a vez
// em vez de receberem erro. E a fila anda sozinha: antes dela, se o cliente
// fechasse a aba no meio, a musica ficava "gerando" para sempre, porque o
// andamento so era consultado quando alguem abria a pagina.

import { gerarMusica, consultarMusica } from './mureka.js';
import * as db from './db.js';

// Tres tentativas: as falhas passageiras da Mureka (timeout, cota momentanea)
// somem na segunda. Depois disso, insistir so adia a devolucao do credito.
const MAX_TENTATIVAS = 3;

/**
 * Uma falha nunca pode custar credito ao cliente: ou tenta de novo sozinha, ou
 * desiste devolvendo o credito. Nenhum caminho deixa a pessoa sem nada.
 */
async function tratarFalha(env, musica, motivo) {
  if ((musica.tentativas ?? 0) + 1 < MAX_TENTATIVAS) {
    await db.reenfileirar(env, musica.id);
    return;
  }

  await db.desistirDaMusica(env, musica.pedido_id, musica.id, motivo);
}

/** Acompanha o que ja esta na Mureka. */
async function acompanharEmGeracao(env) {
  const emGeracao = await db.musicasEmGeracao(env);

  for (const musica of emGeracao) {
    let tarefa;
    try {
      tarefa = await consultarMusica(env, musica.mureka_task_id);
    } catch {
      // Problema de rede nao e falha da musica: tenta de novo na proxima passada.
      continue;
    }

    if (!tarefa.concluida) continue;

    const audio = tarefa.musicas?.[0]?.audio;
    if (tarefa.sucesso && audio) {
      await db.concluirMusica(env, musica.id, { audioUrl: audio });
    } else {
      await tratarFalha(env, musica, tarefa.erro ?? 'a composicao nao foi concluida');
    }
  }
}

/** Comeca a proxima, se a Mureka estiver livre. */
async function comecarProxima(env) {
  if (await db.geracaoEmAndamento(env)) return;

  const proxima = await db.proximaDaFila(env);
  if (!proxima) return;

  // Reserva antes de gastar dinheiro: se outra passada ja pegou esta musica,
  // sai sem abrir uma segunda tarefa para o mesmo credito.
  if (!(await db.reservarDaFila(env, proxima.id))) return;

  try {
    const tarefa = await gerarMusica(env, {
      letra: proxima.letra,
      estilo: proxima.estilo,
      voz: proxima.voz
    });
    await db.anotarTarefaMureka(env, proxima.id, tarefa.id);
  } catch (erro) {
    await tratarFalha(env, proxima, erro.message);
  }
}

/**
 * Empurra a fila um passo. Roda no cron de minuto em minuto e tambem quando
 * alguem abre a pagina do pedido, para quem esta olhando nao esperar o relogio.
 */
export async function empurrarFila(env) {
  if (!env.DB || !env.MUREKA_API_KEY) return;

  await acompanharEmGeracao(env);
  await comecarProxima(env);
}
