-- Falha de geracao nao pode custar credito ao cliente.
--
-- `tentativas` deixa a fila repetir sozinha antes de desistir: a maioria das
-- falhas da Mureka e passageira (timeout, cota momentanea) e uma segunda
-- tentativa resolve sem o cliente ficar sabendo.
--
-- `credito_devolvido` torna a devolucao idempotente. Sem ela, duas passadas do
-- cron sobre a mesma musica devolveriam o credito duas vezes e o cliente
-- ganharia musicas de graca.
ALTER TABLE musicas ADD COLUMN tentativas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE musicas ADD COLUMN credito_devolvido INTEGER NOT NULL DEFAULT 0;
