// Banco de dados SQLite (módulo nativo do Node 22+, sem dependências externas).
// Todos os valores em dinheiro são guardados em CENTAVOS (inteiros) para evitar
// erros de arredondamento. Custos unitários de lote podem ter fração de centavo
// (por causa do rateio dos custos extras), por isso são REAL.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON;');
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  criarTabelas(db);
  return db;
}

function criarTabelas(db) {
  db.exec(`
    -- Pessoas: sócios (pagam compras) e/ou vendedores (registram vendas)
    CREATE TABLE IF NOT EXISTS pessoas (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nome      TEXT NOT NULL,
      socio     INTEGER NOT NULL DEFAULT 0,
      vendedor  INTEGER NOT NULL DEFAULT 1,
      ativo     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS produtos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      nome            TEXT NOT NULL,
      categoria       TEXT,
      preco_venda     INTEGER NOT NULL,          -- centavos
      estoque_minimo  INTEGER NOT NULL DEFAULT 0,
      ativo           INTEGER NOT NULL DEFAULT 1,
      criado_em       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Tipos de custo extra cadastrados (frete, gelo, sacola...)
    CREATE TABLE IF NOT EXISTS tipos_custo (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nome          TEXT NOT NULL,
      valor_padrao  INTEGER NOT NULL DEFAULT 0   -- centavos
    );

    -- Compra = uma entrada de mercadoria (pode ter vários produtos)
    CREATE TABLE IF NOT EXISTS compras (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      data              TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      fornecedor        TEXT,
      metodo_pagamento  TEXT NOT NULL,
      pago_por          INTEGER NOT NULL REFERENCES pessoas(id),
      total_itens       INTEGER NOT NULL,        -- centavos
      total_extras      INTEGER NOT NULL,        -- centavos
      observacao        TEXT
    );

    CREATE TABLE IF NOT EXISTS compra_extras (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id  INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
      descricao  TEXT NOT NULL,
      valor      INTEGER NOT NULL                -- centavos
    );

    -- Lote = cada produto dentro de uma compra, com validade própria
    CREATE TABLE IF NOT EXISTS lotes (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id            INTEGER NOT NULL REFERENCES compras(id),
      produto_id           INTEGER NOT NULL REFERENCES produtos(id),
      quantidade           INTEGER NOT NULL,
      quantidade_restante  INTEGER NOT NULL,
      custo_unitario       INTEGER NOT NULL,     -- centavos (preço pago)
      rateio_unitario      REAL NOT NULL,        -- centavos (parte dos extras)
      custo_final          REAL NOT NULL,        -- custo_unitario + rateio
      validade             TEXT                  -- AAAA-MM-DD
    );
    CREATE INDEX IF NOT EXISTS idx_lotes_produto ON lotes(produto_id, quantidade_restante);

    CREATE TABLE IF NOT EXISTS vendas (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      data         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      vendedor_id  INTEGER NOT NULL REFERENCES pessoas(id),
      subtotal     INTEGER NOT NULL,
      desconto     INTEGER NOT NULL DEFAULT 0,
      total        INTEGER NOT NULL,
      custo_total  REAL NOT NULL,
      recebido     INTEGER NOT NULL,
      troco        INTEGER NOT NULL DEFAULT 0,
      cancelada    INTEGER NOT NULL DEFAULT 0,
      cancelada_em TEXT,
      cancelada_por INTEGER REFERENCES pessoas(id)
    );

    CREATE TABLE IF NOT EXISTS venda_itens (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id        INTEGER NOT NULL REFERENCES vendas(id),
      produto_id      INTEGER NOT NULL REFERENCES produtos(id),
      quantidade      INTEGER NOT NULL,
      preco_unitario  INTEGER NOT NULL,
      custo_total     REAL NOT NULL
    );

    -- De quais lotes saiu cada item (para calcular custo e permitir cancelar)
    CREATE TABLE IF NOT EXISTS movimentos_lote (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id     INTEGER NOT NULL REFERENCES lotes(id),
      quantidade  INTEGER NOT NULL,
      venda_item_id INTEGER REFERENCES venda_itens(id),
      perda_id    INTEGER REFERENCES perdas(id)
    );

    CREATE TABLE IF NOT EXISTS venda_pagamentos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id  INTEGER NOT NULL REFERENCES vendas(id),
      metodo    TEXT NOT NULL,
      valor     INTEGER NOT NULL                 -- valor líquido (sem troco)
    );

    -- Perdas: vencido, quebrado, consumo próprio...
    CREATE TABLE IF NOT EXISTS perdas (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      data         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      produto_id   INTEGER NOT NULL REFERENCES produtos(id),
      quantidade   INTEGER NOT NULL,
      motivo       TEXT NOT NULL,
      custo_total  REAL NOT NULL,
      registrado_por INTEGER REFERENCES pessoas(id)
    );

    -- Despesas fixas/gerais (energia, aluguel...) que não entram no produto
    CREATE TABLE IF NOT EXISTS despesas (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      data              TEXT NOT NULL DEFAULT (date('now','localtime')),
      descricao         TEXT NOT NULL,
      valor             INTEGER NOT NULL,
      metodo_pagamento  TEXT NOT NULL,
      pago_por          INTEGER NOT NULL REFERENCES pessoas(id)
    );

    -- Caixa: abertura com fundo de troco, sangrias/reforços e fechamento com contagem
    CREATE TABLE IF NOT EXISTS caixas (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      aberto_em          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      aberto_por         INTEGER NOT NULL REFERENCES pessoas(id),
      fundo_inicial      INTEGER NOT NULL,       -- centavos
      fechado_em         TEXT,
      fechado_por        INTEGER REFERENCES pessoas(id),
      dinheiro_esperado  INTEGER,                -- calculado no fechamento
      dinheiro_contado   INTEGER,                -- informado no fechamento
      diferenca          INTEGER,                -- contado - esperado
      resumo_json        TEXT,                   -- fotografia dos totais no fechamento
      observacao         TEXT
    );
    -- Garante no máximo um caixa aberto por vez
    CREATE UNIQUE INDEX IF NOT EXISTS idx_um_caixa_aberto ON caixas((1)) WHERE fechado_em IS NULL;

    CREATE TABLE IF NOT EXISTS movimentos_caixa (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id   INTEGER NOT NULL REFERENCES caixas(id),
      data       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      tipo       TEXT NOT NULL CHECK (tipo IN ('sangria','reforco')),
      valor      INTEGER NOT NULL,
      motivo     TEXT,
      pessoa_id  INTEGER NOT NULL REFERENCES pessoas(id)
    );
  `);

  db.exec(`
    -- Sessões de login (token guardado no aparelho)
    CREATE TABLE IF NOT EXISTS sessoes (
      token       TEXT PRIMARY KEY,
      pessoa_id   INTEGER NOT NULL REFERENCES pessoas(id),
      criado_em   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      ultimo_uso  INTEGER NOT NULL           -- epoch ms
    );
  `);

  const colunasDe = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  // Migração: bancos criados antes do caixa não têm vendas.caixa_id
  if (!colunasDe('vendas').includes('caixa_id')) db.exec('ALTER TABLE vendas ADD COLUMN caixa_id INTEGER REFERENCES caixas(id)');
  // Migração: PIN de acesso (hash scrypt), tentativas erradas e bloqueio temporário
  const colPessoas = colunasDe('pessoas');
  if (!colPessoas.includes('pin_hash')) db.exec('ALTER TABLE pessoas ADD COLUMN pin_hash TEXT');
  if (!colPessoas.includes('pin_erros')) db.exec('ALTER TABLE pessoas ADD COLUMN pin_erros INTEGER NOT NULL DEFAULT 0');
  if (!colPessoas.includes('bloqueado_ate')) db.exec('ALTER TABLE pessoas ADD COLUMN bloqueado_ate INTEGER');
}

module.exports = { abrirBanco };
