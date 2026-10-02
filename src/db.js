// Acesso ao D1. Concentra o SQL para as rotas ficarem legiveis e para as
// regras de credito viverem num lugar so.

export class DbError extends Error {
  constructor(mensagem, status = 500) {
    super(mensagem);
    this.name = 'DbError';
    this.status = status;
  }
}

function agora() {
  return Math.floor(Date.now() / 1000);
}

// O id do pedido e o link de acesso do cliente: precisa ser imprevisivel.
// 32 caracteres hex = 128 bits, fora do alcance de tentativa e erro.
export function novoId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function exigirBanco(env) {
  if (!env.DB) throw new DbError('Banco de dados nao configurado.', 503);
  return env.DB;
}

export async function criarPedido(env, { id, nome, email, whatsapp, pacote, creditos, valorCentavos }) {
  await exigirBanco(env)
    .prepare(
      `INSERT INTO pedidos (id, nome, email, whatsapp, pacote, creditos, valor_centavos, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, nome, email, whatsapp, pacote, creditos, valorCentavos, agora())
    .run();
}

export async function buscarPedido(env, id) {
  return exigirBanco(env).prepare('SELECT * FROM pedidos WHERE id = ?').bind(id).first();
}

export async function anotarPreferencia(env, pedidoId, preferenceId) {
  await exigirBanco(env)
    .prepare('UPDATE pedidos SET mp_preference_id = ? WHERE id = ?')
    .bind(preferenceId, pedidoId)
    .run();
}

/**
 * Marca o pedido como pago. O `status = 'pendente'` no WHERE e o que torna a
 * operacao idempotente: um reenvio da notificacao nao reaplica nada.
 * @returns {Promise<boolean>} true se este chamado foi o que efetivou o pagamento.
 */
export async function marcarPago(env, pedidoId, pagamentoId) {
  const r = await exigirBanco(env)
    .prepare(
      `UPDATE pedidos SET status = 'pago', mp_payment_id = ?, pago_em = ?
       WHERE id = ? AND status = 'pendente'`
    )
    .bind(pagamentoId, agora(), pedidoId)
    .run();

  return (r.meta?.changes ?? 0) > 0;
}

export async function marcarStatus(env, pedidoId, status) {
  await exigirBanco(env)
    .prepare(`UPDATE pedidos SET status = ? WHERE id = ? AND status = 'pendente'`)
    .bind(status, pedidoId)
    .run();
}

/**
 * Registra a notificacao. Devolve false se ela ja tinha sido processada —
 * o Mercado Pago reenvia ate receber 200, e sem isso o pedido seria creditado
 * de novo a cada reenvio.
 */
export async function registrarEvento(env, { id, tipo, pedidoId }) {
  try {
    await exigirBanco(env)
      .prepare('INSERT INTO eventos_webhook (id, tipo, pedido_id, recebido_em) VALUES (?, ?, ?, ?)')
      .bind(id, tipo, pedidoId ?? null, agora())
      .run();
    return true;
  } catch (erro) {
    // Chave primaria duplicada = evento repetido, que e o caso esperado aqui.
    if (/UNIQUE|PRIMARY KEY/i.test(String(erro?.message))) return false;
    throw erro;
  }
}

/**
 * Consome um credito e abre a musica, numa operacao so. O
 * `creditos_usados < creditos` no WHERE impede que dois pedidos simultaneos
 * gastem o mesmo credito.
 * @returns {Promise<string|null>} id da musica, ou null se nao havia credito.
 */
export async function consumirCredito(env, pedidoId, dados) {
  const db = exigirBanco(env);
  const musicaId = novoId();

  const [consumo] = await db.batch([
    db
      .prepare(
        `UPDATE pedidos SET creditos_usados = creditos_usados + 1
         WHERE id = ? AND status = 'pago' AND creditos_usados < creditos`
      )
      .bind(pedidoId),
    db
      .prepare(
        `INSERT INTO musicas (id, pedido_id, briefing, titulo, letra, estilo, voz, criado_em)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM pedidos WHERE id = ? AND status = 'pago' AND creditos_usados <= creditos
         )`
      )
      .bind(
        musicaId,
        pedidoId,
        dados.briefing ?? null,
        dados.titulo ?? null,
        dados.letra ?? null,
        dados.estilo ?? null,
        dados.voz ?? null,
        agora(),
        pedidoId
      )
  ]);

  return (consumo.meta?.changes ?? 0) > 0 ? musicaId : null;
}

/** Devolve o credito quando a geracao nem chegou a comecar na Mureka. */
export async function devolverCredito(env, pedidoId, musicaId, motivo) {
  const db = exigirBanco(env);

  await db.batch([
    db
      .prepare(
        `UPDATE pedidos SET creditos_usados = creditos_usados - 1
         WHERE id = ? AND creditos_usados > 0`
      )
      .bind(pedidoId),
    db
      .prepare(`UPDATE musicas SET status = 'falhou', erro = ?, concluido_em = ? WHERE id = ?`)
      .bind(motivo ?? 'falha ao abrir a geracao', agora(), musicaId)
  ]);
}

export async function anotarTarefaMureka(env, musicaId, taskId) {
  await exigirBanco(env)
    .prepare(`UPDATE musicas SET mureka_task_id = ?, status = 'gerando' WHERE id = ?`)
    .bind(taskId, musicaId)
    .run();
}

export async function concluirMusica(env, musicaId, { audioUrl, titulo }) {
  await exigirBanco(env)
    .prepare(
      `UPDATE musicas SET status = 'pronta', audio_url = ?, titulo = COALESCE(?, titulo), concluido_em = ?
       WHERE id = ?`
    )
    .bind(audioUrl, titulo ?? null, agora(), musicaId)
    .run();
}

export async function falharMusica(env, musicaId, motivo) {
  await exigirBanco(env)
    .prepare(`UPDATE musicas SET status = 'falhou', erro = ?, concluido_em = ? WHERE id = ?`)
    .bind(motivo ?? 'falhou', agora(), musicaId)
    .run();
}

export async function musicasDoPedido(env, pedidoId) {
  const r = await exigirBanco(env)
    .prepare(
      `SELECT id, titulo, status, audio_url, erro, criado_em, concluido_em
       FROM musicas WHERE pedido_id = ? ORDER BY criado_em`
    )
    .bind(pedidoId)
    .all();

  return r.results ?? [];
}

export async function buscarMusica(env, musicaId) {
  return exigirBanco(env).prepare('SELECT * FROM musicas WHERE id = ?').bind(musicaId).first();
}

/** Ha alguma geracao em andamento? O plano da Mureka permite uma por vez. */
export async function geracaoEmAndamento(env) {
  const r = await exigirBanco(env)
    .prepare(`SELECT COUNT(*) AS n FROM musicas WHERE status = 'gerando'`)
    .first();

  return (r?.n ?? 0) > 0;
}
