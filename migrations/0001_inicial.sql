-- Esquema inicial: pedidos, musicas geradas e idempotencia do webhook.

-- Um pedido e a compra de um pacote de creditos. O id e o token secreto que
-- o cliente recebe no link de acesso, entao precisa ser imprevisivel.
CREATE TABLE pedidos (
  id               TEXT PRIMARY KEY,
  nome             TEXT    NOT NULL,
  email            TEXT    NOT NULL,
  whatsapp         TEXT    NOT NULL,
  pacote           TEXT    NOT NULL,
  creditos         INTEGER NOT NULL,
  creditos_usados  INTEGER NOT NULL DEFAULT 0,
  valor_centavos   INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pendente',
  mp_preference_id TEXT,
  mp_payment_id    TEXT,
  criado_em        INTEGER NOT NULL,
  pago_em          INTEGER,

  CHECK (status IN ('pendente', 'pago', 'recusado', 'estornado', 'cancelado')),
  CHECK (creditos_usados >= 0 AND creditos_usados <= creditos)
);

CREATE INDEX idx_pedidos_status ON pedidos (status);
CREATE INDEX idx_pedidos_preference ON pedidos (mp_preference_id);
CREATE INDEX idx_pedidos_email ON pedidos (email);

-- Cada musica gasta um credito do pedido.
CREATE TABLE musicas (
  id              TEXT PRIMARY KEY,
  pedido_id       TEXT    NOT NULL REFERENCES pedidos(id),
  briefing        TEXT,
  titulo          TEXT,
  letra           TEXT,
  estilo          TEXT,
  voz             TEXT,
  mureka_task_id  TEXT,
  status          TEXT    NOT NULL DEFAULT 'na_fila',
  audio_url       TEXT,
  erro            TEXT,
  criado_em       INTEGER NOT NULL,
  concluido_em    INTEGER,

  CHECK (status IN ('na_fila', 'gerando', 'pronta', 'falhou'))
);

CREATE INDEX idx_musicas_pedido ON musicas (pedido_id);
CREATE INDEX idx_musicas_status ON musicas (status);

-- O Mercado Pago reenvia a mesma notificacao ate receber 200. Sem registro do
-- que ja foi processado, um reenvio creditaria o pedido duas vezes.
CREATE TABLE eventos_webhook (
  id           TEXT PRIMARY KEY,
  tipo         TEXT    NOT NULL,
  pedido_id    TEXT,
  recebido_em  INTEGER NOT NULL
);
