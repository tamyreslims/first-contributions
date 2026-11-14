// Regras de negócio do Geladão. Independente do HTTP para facilitar testes.

const METODOS_COMPRA = ['dinheiro', 'pix', 'debito', 'credito', 'boleto', 'transferencia'];
const METODOS_VENDA = ['dinheiro', 'pix', 'debito', 'credito'];
const MOTIVOS_PERDA = ['vencido', 'quebrado', 'consumo', 'outro'];

const crypto = require('node:crypto');

// PIN guardado como hash scrypt com sal aleatório: "sal:hash" em hex
function hashPin(pin) {
  const sal = crypto.randomBytes(16);
  return sal.toString('hex') + ':' + crypto.scryptSync(pin, sal, 32).toString('hex');
}
function conferirPin(pin, guardado) {
  const [salHex, hashHex] = String(guardado).split(':');
  if (!salHex || !hashHex) return false;
  const calc = crypto.scryptSync(pin, Buffer.from(salHex, 'hex'), 32);
  const ref = Buffer.from(hashHex, 'hex');
  return ref.length === calc.length && crypto.timingSafeEqual(ref, calc);
}

class ErroValidacao extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

function exigir(cond, msg) { if (!cond) throw new ErroValidacao(msg); }
function inteiroPositivo(v) { return Number.isInteger(v) && v > 0; }
function inteiroNaoNegativo(v) { return Number.isInteger(v) && v >= 0; }
function texto(v) { return typeof v === 'string' && v.trim().length > 0; }
function dataValida(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)); }

function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function criarLogica(db, opcoes = {}) {
  const L = {};

  // ---------------- Pessoas e acesso (PIN) ----------------
  const CAMPOS_PESSOA = 'id, nome, socio, vendedor, ativo, (pin_hash IS NOT NULL) AS tem_pin';
  const umaPessoa = (id) => db.prepare(`SELECT ${CAMPOS_PESSOA} FROM pessoas WHERE id=?`).get(id);
  L.listarPessoas = () => db.prepare(`SELECT ${CAMPOS_PESSOA} FROM pessoas ORDER BY ativo DESC, nome`).all();
  L.temPessoas = () => !!db.prepare('SELECT 1 FROM pessoas LIMIT 1').get();

  function validarPin(pin) { exigir(typeof pin === 'string' && /^\d{4}$/.test(pin), 'O PIN deve ter 4 números.'); }

  L.salvarPessoa = (dados, id) => {
    exigir(texto(dados.nome), 'Informe o nome.');
    const socio = dados.socio ? 1 : 0;
    const vendedor = dados.vendedor ? 1 : 0;
    const ativo = dados.ativo === false ? 0 : 1;
    exigir(socio || vendedor, 'A pessoa precisa ser sócio, vendedor ou os dois.');
    const pin = dados.pin == null || dados.pin === '' ? null : String(dados.pin);
    if (pin) validarPin(pin);
    return transacao(db, () => {
      if (id) {
        const r = db.prepare('UPDATE pessoas SET nome=?, socio=?, vendedor=?, ativo=? WHERE id=?')
          .run(dados.nome.trim(), socio, vendedor, ativo, id);
        exigir(r.changes === 1, 'Pessoa não encontrada.');
        if (pin) db.prepare('UPDATE pessoas SET pin_hash=?, pin_erros=0, bloqueado_ate=NULL WHERE id=?').run(hashPin(pin), id);
        if (!ativo || !socio) {
          exigir(db.prepare('SELECT 1 FROM pessoas WHERE socio=1 AND ativo=1').get(), 'É preciso manter pelo menos um sócio ativo.');
        }
        // Inativado ou PIN trocado: derruba as sessões abertas dessa pessoa
        if (!ativo || pin) db.prepare('DELETE FROM sessoes WHERE pessoa_id=?').run(id);
        return umaPessoa(id);
      }
      const r = db.prepare('INSERT INTO pessoas (nome, socio, vendedor, ativo, pin_hash) VALUES (?,?,?,?,?)')
        .run(dados.nome.trim(), socio, vendedor, ativo, pin ? hashPin(pin) : null);
      return umaPessoa(r.lastInsertRowid);
    });
  };

  const MAX_ERROS = 5;
  const BLOQUEIO_MS = 5 * 60 * 1000;
  const SESSAO_MS = (Number(opcoes.sessaoMinutos) || 10) * 60 * 1000;
  const agora = opcoes.relogio || (() => Date.now());

  // Primeiro uso: cria o primeiro sócio já com PIN e entra
  L.configurarPrimeiroUso = ({ nome, pin }) => {
    exigir(!L.temPessoas(), 'O sistema já foi configurado.');
    validarPin(String(pin ?? ''));
    const p = L.salvarPessoa({ nome, socio: true, vendedor: true, pin: String(pin) });
    return criarSessao(p.id);
  };

  function criarSessao(pessoaId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessoes (token, pessoa_id, ultimo_uso) VALUES (?,?,?)').run(token, pessoaId, agora());
    return { token, pessoa: umaPessoa(pessoaId), expira_minutos: SESSAO_MS / 60000 };
  }

  // Login: se a pessoa ainda não tem PIN (cadastro antigo), o PIN informado vira o PIN dela.
  L.login = ({ pessoa_id, pin }) => {
    const p = db.prepare('SELECT * FROM pessoas WHERE id=? AND ativo=1').get(pessoa_id);
    exigir(p, 'Pessoa não encontrada ou inativa.');
    validarPin(String(pin ?? ''));
    const t = agora();
    if (p.bloqueado_ate && p.bloqueado_ate > t) {
      const min = Math.ceil((p.bloqueado_ate - t) / 60000);
      throw Object.assign(new ErroValidacao(`Muitas tentativas erradas. Tente de novo em ${min} minuto(s).`), { status: 429 });
    }
    if (!p.pin_hash) {
      db.prepare('UPDATE pessoas SET pin_hash=?, pin_erros=0, bloqueado_ate=NULL WHERE id=?').run(hashPin(String(pin)), p.id);
      return { ...criarSessao(p.id), pin_criado: true };
    }
    if (!conferirPin(String(pin), p.pin_hash)) {
      const erros = p.pin_erros + 1;
      if (erros >= MAX_ERROS) {
        db.prepare('UPDATE pessoas SET pin_erros=0, bloqueado_ate=? WHERE id=?').run(t + BLOQUEIO_MS, p.id);
        throw Object.assign(new ErroValidacao('PIN errado. Acesso bloqueado por 5 minutos.'), { status: 429 });
      }
      db.prepare('UPDATE pessoas SET pin_erros=? WHERE id=?').run(erros, p.id);
      throw Object.assign(new ErroValidacao(`PIN errado. Restam ${MAX_ERROS - erros} tentativa(s).`), { status: 401 });
    }
    db.prepare('UPDATE pessoas SET pin_erros=0, bloqueado_ate=NULL WHERE id=?').run(p.id);
    return criarSessao(p.id);
  };

  // Valida o token; renova o prazo a cada uso. Retorna a pessoa ou null.
  L.sessao = (token) => {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const s = db.prepare(`SELECT s.ultimo_uso, p.id, p.nome, p.socio, p.vendedor, p.ativo FROM sessoes s
      JOIN pessoas p ON p.id=s.pessoa_id WHERE s.token=?`).get(token);
    const t = agora();
    if (!s || !s.ativo || t - s.ultimo_uso > SESSAO_MS) {
      if (s) db.prepare('DELETE FROM sessoes WHERE token=?').run(token);
      return null;
    }
    db.prepare('UPDATE sessoes SET ultimo_uso=? WHERE token=?').run(t, token);
    return { id: s.id, nome: s.nome, socio: s.socio, vendedor: s.vendedor, ativo: s.ativo };
  };

  L.logout = (token) => { db.prepare('DELETE FROM sessoes WHERE token=?').run(token); return { ok: true }; };

  L.trocarPin = (pessoaId, { atual, novo }) => {
    const p = db.prepare('SELECT * FROM pessoas WHERE id=?').get(pessoaId);
    exigir(p && p.pin_hash && conferirPin(String(atual ?? ''), p.pin_hash), 'PIN atual errado.');
    validarPin(String(novo ?? ''));
    db.prepare('UPDATE pessoas SET pin_hash=? WHERE id=?').run(hashPin(String(novo)), pessoaId);
    return { ok: true };
  };

  function pessoa(id, papel) {
    const p = db.prepare('SELECT * FROM pessoas WHERE id=? AND ativo=1').get(id);
    exigir(p, 'Pessoa não encontrada ou inativa.');
    if (papel) exigir(p[papel] === 1, `${p.nome} não está cadastrado(a) como ${papel}.`);
    return p;
  }

  // ---------------- Produtos ----------------
  L.listarProdutos = () => db.prepare(`
    SELECT p.*,
      COALESCE((SELECT SUM(quantidade_restante) FROM lotes l WHERE l.produto_id=p.id), 0) AS estoque,
      (SELECT MIN(validade) FROM lotes l WHERE l.produto_id=p.id AND quantidade_restante>0) AS proxima_validade,
      (SELECT custo_final FROM lotes l WHERE l.produto_id=p.id ORDER BY id DESC LIMIT 1) AS ultimo_custo,
      (SELECT SUM(quantidade_restante*custo_final)/NULLIF(SUM(quantidade_restante),0)
         FROM lotes l WHERE l.produto_id=p.id AND quantidade_restante>0) AS custo_medio_estoque
    FROM produtos p
    ORDER BY p.ativo DESC, p.nome
  `).all().map((p) => {
    const custoRef = p.custo_medio_estoque ?? p.ultimo_custo;
    return {
      ...p,
      lucro_unitario: custoRef == null ? null : p.preco_venda - custoRef,
      margem: custoRef == null || p.preco_venda === 0 ? null : (p.preco_venda - custoRef) / p.preco_venda,
    };
  });

  L.salvarProduto = (dados, id) => {
    exigir(texto(dados.nome), 'Informe o nome do produto.');
    exigir(inteiroNaoNegativo(dados.preco_venda), 'Preço de venda inválido.');
    const min = dados.estoque_minimo ?? 0;
    exigir(inteiroNaoNegativo(min), 'Estoque mínimo inválido.');
    const ativo = dados.ativo === false ? 0 : 1;
    const cat = texto(dados.categoria) ? dados.categoria.trim() : null;
    if (id) {
      const r = db.prepare('UPDATE produtos SET nome=?, categoria=?, preco_venda=?, estoque_minimo=?, ativo=? WHERE id=?')
        .run(dados.nome.trim(), cat, dados.preco_venda, min, ativo, id);
      exigir(r.changes === 1, 'Produto não encontrado.');
      return db.prepare('SELECT * FROM produtos WHERE id=?').get(id);
    }
    const r = db.prepare('INSERT INTO produtos (nome, categoria, preco_venda, estoque_minimo, ativo) VALUES (?,?,?,?,?)')
      .run(dados.nome.trim(), cat, dados.preco_venda, min, ativo);
    return db.prepare('SELECT * FROM produtos WHERE id=?').get(r.lastInsertRowid);
  };

  // ---------------- Tipos de custo extra ----------------
  L.listarTiposCusto = () => db.prepare('SELECT * FROM tipos_custo ORDER BY nome').all();
  L.salvarTipoCusto = (dados, id) => {
    exigir(texto(dados.nome), 'Informe o nome do custo.');
    const v = dados.valor_padrao ?? 0;
    exigir(inteiroNaoNegativo(v), 'Valor inválido.');
    if (id) {
      db.prepare('UPDATE tipos_custo SET nome=?, valor_padrao=? WHERE id=?').run(dados.nome.trim(), v, id);
      return db.prepare('SELECT * FROM tipos_custo WHERE id=?').get(id);
    }
    const r = db.prepare('INSERT INTO tipos_custo (nome, valor_padrao) VALUES (?,?)').run(dados.nome.trim(), v);
    return db.prepare('SELECT * FROM tipos_custo WHERE id=?').get(r.lastInsertRowid);
  };
  L.excluirTipoCusto = (id) => { db.prepare('DELETE FROM tipos_custo WHERE id=?').run(id); return { ok: true }; };

  // ---------------- Compras (entrada de estoque) ----------------
  // Os custos extras são rateados entre os itens proporcionalmente ao valor
  // de cada item na compra (quem custou mais absorve mais frete).
  L.registrarCompra = (dados) => {
    exigir(METODOS_COMPRA.includes(dados.metodo_pagamento), 'Método de pagamento inválido.');
    pessoa(dados.pago_por, 'socio');
    exigir(Array.isArray(dados.itens) && dados.itens.length > 0, 'Adicione pelo menos um produto.');
    const extras = dados.extras || [];
    exigir(Array.isArray(extras), 'Custos extras inválidos.');

    for (const it of dados.itens) {
      exigir(db.prepare('SELECT 1 FROM produtos WHERE id=?').get(it.produto_id), 'Produto não encontrado.');
      exigir(inteiroPositivo(it.quantidade), 'Quantidade inválida.');
      exigir(inteiroNaoNegativo(it.custo_unitario), 'Custo unitário inválido.');
      exigir(it.validade == null || it.validade === '' || dataValida(it.validade), 'Validade inválida.');
    }
    for (const ex of extras) {
      exigir(texto(ex.descricao), 'Descreva o custo extra.');
      exigir(inteiroPositivo(ex.valor), 'Valor do custo extra inválido.');
    }

    const totalItens = dados.itens.reduce((s, it) => s + it.quantidade * it.custo_unitario, 0);
    const totalExtras = extras.reduce((s, e) => s + e.valor, 0);
    const totalQtd = dados.itens.reduce((s, it) => s + it.quantidade, 0);

    return transacao(db, () => {
      const c = db.prepare(`INSERT INTO compras (fornecedor, metodo_pagamento, pago_por, total_itens, total_extras, observacao)
        VALUES (?,?,?,?,?,?)`).run(
        texto(dados.fornecedor) ? dados.fornecedor.trim() : null,
        dados.metodo_pagamento, dados.pago_por, totalItens, totalExtras,
        texto(dados.observacao) ? dados.observacao.trim() : null);
      const compraId = c.lastInsertRowid;

      const insEx = db.prepare('INSERT INTO compra_extras (compra_id, descricao, valor) VALUES (?,?,?)');
      for (const ex of extras) insEx.run(compraId, ex.descricao.trim(), ex.valor);

      const insLote = db.prepare(`INSERT INTO lotes
        (compra_id, produto_id, quantidade, quantidade_restante, custo_unitario, rateio_unitario, custo_final, validade)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const it of dados.itens) {
        const valorItem = it.quantidade * it.custo_unitario;
        // Se tudo foi de graça (total 0), rateia por quantidade.
        const parteExtras = totalItens > 0
          ? totalExtras * (valorItem / totalItens)
          : totalExtras * (it.quantidade / totalQtd);
        const rateio = parteExtras / it.quantidade;
        insLote.run(compraId, it.produto_id, it.quantidade, it.quantidade,
          it.custo_unitario, rateio, it.custo_unitario + rateio, it.validade || null);
      }
      return L.obterCompra(compraId);
    });
  };

  L.obterCompra = (id) => {
    const c = db.prepare(`SELECT c.*, p.nome AS pago_por_nome FROM compras c JOIN pessoas p ON p.id=c.pago_por WHERE c.id=?`).get(id);
    if (!c) return null;
    c.extras = db.prepare('SELECT * FROM compra_extras WHERE compra_id=?').all(id);
    c.itens = db.prepare(`SELECT l.*, pr.nome AS produto_nome FROM lotes l JOIN produtos pr ON pr.id=l.produto_id WHERE compra_id=?`).all(id);
    return c;
  };

  L.listarCompras = ({ de, ate } = {}) => {
    const rows = db.prepare(`SELECT c.*, p.nome AS pago_por_nome FROM compras c JOIN pessoas p ON p.id=c.pago_por
      WHERE date(c.data) BETWEEN ? AND ? ORDER BY c.id DESC LIMIT 200`).all(de || '0000-01-01', ate || '9999-12-31');
    return rows.map((c) => ({ ...c, itens: db.prepare(`SELECT l.produto_id, l.quantidade, l.custo_unitario, l.custo_final, l.validade, pr.nome AS produto_nome
      FROM lotes l JOIN produtos pr ON pr.id=l.produto_id WHERE compra_id=?`).all(c.id) }));
  };

  // ---------------- Baixa de estoque (FEFO: vence primeiro, sai primeiro) ----------------
  function consumirEstoque(produtoId, qtd) {
    const lotes = db.prepare(`SELECT id, quantidade_restante, custo_final FROM lotes
      WHERE produto_id=? AND quantidade_restante>0
      ORDER BY validade IS NULL, validade, id`).all(produtoId);
    const disponivel = lotes.reduce((s, l) => s + l.quantidade_restante, 0);
    if (disponivel < qtd) {
      const p = db.prepare('SELECT nome FROM produtos WHERE id=?').get(produtoId);
      throw new ErroValidacao(`Estoque insuficiente de "${p ? p.nome : produtoId}": disponível ${disponivel}, pedido ${qtd}.`);
    }
    const usados = [];
    let falta = qtd;
    const upd = db.prepare('UPDATE lotes SET quantidade_restante = quantidade_restante - ? WHERE id=?');
    for (const l of lotes) {
      if (falta === 0) break;
      const q = Math.min(falta, l.quantidade_restante);
      upd.run(q, l.id);
      usados.push({ lote_id: l.id, quantidade: q, custo: q * l.custo_final });
      falta -= q;
    }
    return usados;
  }

  // ---------------- Vendas ----------------
  L.registrarVenda = (dados) => {
    pessoa(dados.vendedor_id, 'vendedor');
    const caixa = caixaAberto();
    exigir(caixa, 'O caixa está fechado. Abra o caixa antes de vender.');
    exigir(Array.isArray(dados.itens) && dados.itens.length > 0, 'Adicione pelo menos um produto.');
    exigir(Array.isArray(dados.pagamentos) && dados.pagamentos.length > 0, 'Informe a forma de pagamento.');
    const desconto = dados.desconto ?? 0;
    exigir(inteiroNaoNegativo(desconto), 'Desconto inválido.');

    // Junta itens repetidos do mesmo produto
    const porProduto = new Map();
    for (const it of dados.itens) {
      exigir(inteiroPositivo(it.quantidade), 'Quantidade inválida.');
      const prod = db.prepare('SELECT * FROM produtos WHERE id=? AND ativo=1').get(it.produto_id);
      exigir(prod, 'Produto não encontrado ou inativo.');
      const atual = porProduto.get(prod.id);
      if (atual) atual.quantidade += it.quantidade;
      else porProduto.set(prod.id, { produto: prod, quantidade: it.quantidade });
    }
    const itens = [...porProduto.values()];
    const subtotal = itens.reduce((s, it) => s + it.quantidade * it.produto.preco_venda, 0);
    exigir(desconto <= subtotal, 'Desconto maior que o valor da venda.');
    const total = subtotal - desconto;

    for (const pg of dados.pagamentos) {
      exigir(METODOS_VENDA.includes(pg.metodo), 'Forma de pagamento inválida.');
      exigir(inteiroPositivo(pg.valor), 'Valor de pagamento inválido.');
    }
    const recebido = dados.pagamentos.reduce((s, p) => s + p.valor, 0);
    exigir(recebido >= total, `Pagamento insuficiente: faltam ${((total - recebido) / 100).toFixed(2)}.`);
    const troco = recebido - total;
    const emDinheiro = dados.pagamentos.filter((p) => p.metodo === 'dinheiro').reduce((s, p) => s + p.valor, 0);
    exigir(troco === 0 || emDinheiro >= troco, 'Troco só pode ser dado em pagamento em dinheiro.');

    // Valor líquido por método: o troco sai do dinheiro
    const liquido = new Map();
    for (const pg of dados.pagamentos) liquido.set(pg.metodo, (liquido.get(pg.metodo) || 0) + pg.valor);
    if (troco > 0) liquido.set('dinheiro', liquido.get('dinheiro') - troco);

    return transacao(db, () => {
      const v = db.prepare(`INSERT INTO vendas (vendedor_id, subtotal, desconto, total, custo_total, recebido, troco, caixa_id)
        VALUES (?,?,?,?,0,?,?,?)`).run(dados.vendedor_id, subtotal, desconto, total, recebido, troco, caixa.id);
      const vendaId = v.lastInsertRowid;
      let custoTotal = 0;
      const insItem = db.prepare(`INSERT INTO venda_itens (venda_id, produto_id, quantidade, preco_unitario, custo_total) VALUES (?,?,?,?,?)`);
      const insMov = db.prepare('INSERT INTO movimentos_lote (lote_id, quantidade, venda_item_id) VALUES (?,?,?)');
      for (const it of itens) {
        const usados = consumirEstoque(it.produto.id, it.quantidade);
        const custo = usados.reduce((s, u) => s + u.custo, 0);
        custoTotal += custo;
        const r = insItem.run(vendaId, it.produto.id, it.quantidade, it.produto.preco_venda, custo);
        for (const u of usados) insMov.run(u.lote_id, u.quantidade, r.lastInsertRowid);
      }
      db.prepare('UPDATE vendas SET custo_total=? WHERE id=?').run(custoTotal, vendaId);
      const insPg = db.prepare('INSERT INTO venda_pagamentos (venda_id, metodo, valor) VALUES (?,?,?)');
      for (const [metodo, valor] of liquido) if (valor > 0) insPg.run(vendaId, metodo, valor);
      return L.obterVenda(vendaId);
    });
  };

  L.obterVenda = (id) => {
    const v = db.prepare(`SELECT v.*, p.nome AS vendedor_nome FROM vendas v JOIN pessoas p ON p.id=v.vendedor_id WHERE v.id=?`).get(id);
    if (!v) return null;
    v.itens = db.prepare(`SELECT vi.*, pr.nome AS produto_nome FROM venda_itens vi JOIN produtos pr ON pr.id=vi.produto_id WHERE venda_id=?`).all(id);
    v.pagamentos = db.prepare('SELECT metodo, valor FROM venda_pagamentos WHERE venda_id=?').all(id);
    v.lucro = v.total - v.custo_total;
    return v;
  };

  L.listarVendas = ({ de, ate, vendedor_id } = {}) => {
    const ids = db.prepare(`SELECT id FROM vendas WHERE date(data) BETWEEN ? AND ?
      AND (? IS NULL OR vendedor_id = ?) ORDER BY id DESC LIMIT 300`)
      .all(de || '0000-01-01', ate || '9999-12-31', vendedor_id ?? null, vendedor_id ?? null);
    return ids.map((r) => L.obterVenda(r.id));
  };

  L.cancelarVenda = (id, pessoaId) => {
    pessoa(pessoaId);
    const v = db.prepare('SELECT * FROM vendas WHERE id=?').get(id);
    exigir(v, 'Venda não encontrada.');
    exigir(!v.cancelada, 'Venda já cancelada.');
    if (v.caixa_id) {
      const cx = db.prepare('SELECT fechado_em FROM caixas WHERE id=?').get(v.caixa_id);
      exigir(!cx.fechado_em, 'Esta venda é de um caixa já fechado e não pode mais ser cancelada.');
    }
    return transacao(db, () => {
      const movs = db.prepare(`SELECT m.lote_id, m.quantidade FROM movimentos_lote m
        JOIN venda_itens vi ON vi.id=m.venda_item_id WHERE vi.venda_id=?`).all(id);
      const dev = db.prepare('UPDATE lotes SET quantidade_restante = quantidade_restante + ? WHERE id=?');
      for (const m of movs) dev.run(m.quantidade, m.lote_id);
      db.prepare(`UPDATE vendas SET cancelada=1, cancelada_em=datetime('now','localtime'), cancelada_por=? WHERE id=?`).run(pessoaId, id);
      return L.obterVenda(id);
    });
  };

  // ---------------- Perdas ----------------
  L.registrarPerda = (dados) => {
    exigir(db.prepare('SELECT 1 FROM produtos WHERE id=?').get(dados.produto_id), 'Produto não encontrado.');
    exigir(inteiroPositivo(dados.quantidade), 'Quantidade inválida.');
    exigir(MOTIVOS_PERDA.includes(dados.motivo), 'Motivo inválido.');
    if (dados.registrado_por != null) pessoa(dados.registrado_por);
    return transacao(db, () => {
      const r = db.prepare('INSERT INTO perdas (produto_id, quantidade, motivo, custo_total, registrado_por) VALUES (?,?,?,0,?)')
        .run(dados.produto_id, dados.quantidade, dados.motivo, dados.registrado_por ?? null);
      const usados = consumirEstoque(dados.produto_id, dados.quantidade);
      const custo = usados.reduce((s, u) => s + u.custo, 0);
      const insMov = db.prepare('INSERT INTO movimentos_lote (lote_id, quantidade, perda_id) VALUES (?,?,?)');
      for (const u of usados) insMov.run(u.lote_id, u.quantidade, r.lastInsertRowid);
      db.prepare('UPDATE perdas SET custo_total=? WHERE id=?').run(custo, r.lastInsertRowid);
      return db.prepare('SELECT * FROM perdas WHERE id=?').get(r.lastInsertRowid);
    });
  };

  L.listarPerdas = ({ de, ate } = {}) => db.prepare(`SELECT pe.*, pr.nome AS produto_nome FROM perdas pe
    JOIN produtos pr ON pr.id=pe.produto_id WHERE date(pe.data) BETWEEN ? AND ? ORDER BY pe.id DESC LIMIT 200`)
    .all(de || '0000-01-01', ate || '9999-12-31');

  // ---------------- Despesas ----------------
  L.registrarDespesa = (dados) => {
    exigir(texto(dados.descricao), 'Descreva a despesa.');
    exigir(inteiroPositivo(dados.valor), 'Valor inválido.');
    exigir(METODOS_COMPRA.includes(dados.metodo_pagamento), 'Método de pagamento inválido.');
    pessoa(dados.pago_por, 'socio');
    const data = dataValida(dados.data) ? dados.data : null;
    const r = db.prepare(`INSERT INTO despesas (data, descricao, valor, metodo_pagamento, pago_por)
      VALUES (COALESCE(?, date('now','localtime')),?,?,?,?)`)
      .run(data, dados.descricao.trim(), dados.valor, dados.metodo_pagamento, dados.pago_por);
    return db.prepare('SELECT * FROM despesas WHERE id=?').get(r.lastInsertRowid);
  };

  L.listarDespesas = ({ de, ate } = {}) => db.prepare(`SELECT d.*, p.nome AS pago_por_nome FROM despesas d
    JOIN pessoas p ON p.id=d.pago_por WHERE d.data BETWEEN ? AND ? ORDER BY d.data DESC, d.id DESC`)
    .all(de || '0000-01-01', ate || '9999-12-31');

  // ---------------- Relatórios ----------------
  L.resumo = ({ de, ate } = {}) => {
    const a = de || '0000-01-01', b = ate || '9999-12-31';
    const vendas = db.prepare(`SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS faturamento,
      COALESCE(SUM(custo_total),0) AS custo, COALESCE(SUM(desconto),0) AS descontos
      FROM vendas WHERE cancelada=0 AND date(data) BETWEEN ? AND ?`).get(a, b);
    const porMetodo = db.prepare(`SELECT vp.metodo, SUM(vp.valor) AS valor FROM venda_pagamentos vp
      JOIN vendas v ON v.id=vp.venda_id WHERE v.cancelada=0 AND date(v.data) BETWEEN ? AND ?
      GROUP BY vp.metodo ORDER BY valor DESC`).all(a, b);
    const porVendedor = db.prepare(`SELECT p.nome, COUNT(*) AS vendas, SUM(v.total) AS total, SUM(v.total - v.custo_total) AS lucro
      FROM vendas v JOIN pessoas p ON p.id=v.vendedor_id WHERE v.cancelada=0 AND date(v.data) BETWEEN ? AND ?
      GROUP BY p.id ORDER BY total DESC`).all(a, b);
    const maisVendidos = db.prepare(`SELECT pr.nome, SUM(vi.quantidade) AS quantidade,
      SUM(vi.quantidade*vi.preco_unitario) AS total, SUM(vi.quantidade*vi.preco_unitario - vi.custo_total) AS lucro
      FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id JOIN produtos pr ON pr.id=vi.produto_id
      WHERE v.cancelada=0 AND date(v.data) BETWEEN ? AND ?
      GROUP BY pr.id ORDER BY quantidade DESC LIMIT 15`).all(a, b);
    const perdas = db.prepare(`SELECT COALESCE(SUM(custo_total),0) AS custo FROM perdas WHERE date(data) BETWEEN ? AND ?`).get(a, b);
    const despesas = db.prepare(`SELECT COALESCE(SUM(valor),0) AS total FROM despesas WHERE data BETWEEN ? AND ?`).get(a, b);
    const lucroBruto = vendas.faturamento - vendas.custo;
    return {
      vendas: vendas.qtd,
      faturamento: vendas.faturamento,
      custo_mercadoria: vendas.custo,
      descontos: vendas.descontos,
      lucro_bruto: lucroBruto,
      perdas: perdas.custo,
      despesas: despesas.total,
      lucro_final: lucroBruto - perdas.custo - despesas.total,
      por_metodo: porMetodo,
      por_vendedor: porVendedor,
      mais_vendidos: maisVendidos,
    };
  };

  // Quanto cada sócio já investiu (compras + despesas) e o acerto para igualar.
  L.acertoSocios = ({ de, ate } = {}) => {
    const a = de || '0000-01-01', b = ate || '9999-12-31';
    const socios = db.prepare(`SELECT p.id, p.nome,
      COALESCE((SELECT SUM(total_itens + total_extras) FROM compras c WHERE c.pago_por=p.id AND date(c.data) BETWEEN ? AND ?),0) AS compras,
      COALESCE((SELECT SUM(valor) FROM despesas d WHERE d.pago_por=p.id AND d.data BETWEEN ? AND ?),0) AS despesas
      FROM pessoas p WHERE p.socio=1 ORDER BY p.nome`).all(a, b, a, b);
    const total = socios.reduce((s, x) => s + x.compras + x.despesas, 0);
    const media = socios.length ? total / socios.length : 0;
    return {
      total_investido: total,
      parte_de_cada: media,
      socios: socios.map((s) => {
        const investido = s.compras + s.despesas;
        return { ...s, investido, saldo: investido - media }; // saldo>0: tem a receber
      }),
    };
  };

  L.alertas = (dias = 7) => {
    const estoqueBaixo = L.listarProdutos().filter((p) => p.ativo && p.estoque <= p.estoque_minimo);
    const vencendo = db.prepare(`SELECT l.id, l.validade, l.quantidade_restante, pr.nome AS produto_nome,
      CAST(julianday(l.validade) - julianday(date('now','localtime')) AS INTEGER) AS dias
      FROM lotes l JOIN produtos pr ON pr.id=l.produto_id
      WHERE l.quantidade_restante>0 AND l.validade IS NOT NULL
        AND l.validade <= date('now','localtime', ?)
      ORDER BY l.validade`).all(`+${dias} days`);
    return { estoque_baixo: estoqueBaixo, vencendo };
  };

  // ---------------- Caixa ----------------
  function caixaAberto() { return db.prepare('SELECT * FROM caixas WHERE fechado_em IS NULL').get() || null; }

  // Totais de um caixa calculados a partir das vendas e movimentos
  function calcularCaixa(cx) {
    const vendas = db.prepare(`SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total
      FROM vendas WHERE caixa_id=? AND cancelada=0`).get(cx.id);
    const canceladas = db.prepare('SELECT COUNT(*) AS qtd FROM vendas WHERE caixa_id=? AND cancelada=1').get(cx.id).qtd;
    const porMetodo = Object.fromEntries(METODOS_VENDA.map((m) => [m, 0]));
    for (const r of db.prepare(`SELECT vp.metodo, SUM(vp.valor) AS valor FROM venda_pagamentos vp
      JOIN vendas v ON v.id=vp.venda_id WHERE v.caixa_id=? AND v.cancelada=0 GROUP BY vp.metodo`).all(cx.id)) porMetodo[r.metodo] = r.valor;
    const movimentos = db.prepare(`SELECT m.*, p.nome AS pessoa_nome FROM movimentos_caixa m
      JOIN pessoas p ON p.id=m.pessoa_id WHERE caixa_id=? ORDER BY m.id`).all(cx.id);
    const sangrias = movimentos.filter((m) => m.tipo === 'sangria').reduce((s, m) => s + m.valor, 0);
    const reforcos = movimentos.filter((m) => m.tipo === 'reforco').reduce((s, m) => s + m.valor, 0);
    return {
      vendas: vendas.qtd, canceladas, total_vendas: vendas.total, por_metodo: porMetodo,
      sangrias, reforcos, movimentos,
      dinheiro_esperado: cx.fundo_inicial + porMetodo.dinheiro + reforcos - sangrias,
    };
  }

  L.obterCaixa = (id) => {
    const cx = db.prepare(`SELECT c.*, a.nome AS aberto_por_nome, f.nome AS fechado_por_nome FROM caixas c
      JOIN pessoas a ON a.id=c.aberto_por LEFT JOIN pessoas f ON f.id=c.fechado_por WHERE c.id=?`).get(id);
    if (!cx) return null;
    const atual = calcularCaixa(cx);
    if (cx.resumo_json) {
      const foto = JSON.parse(cx.resumo_json);
      delete cx.resumo_json;
      return { ...cx, ...atual, ...foto, dinheiro_esperado: cx.dinheiro_esperado, aberto: false };
    }
    delete cx.resumo_json;
    return { ...cx, ...atual, aberto: true };
  };

  L.caixaAtual = () => { const cx = caixaAberto(); return cx ? L.obterCaixa(cx.id) : null; };

  L.abrirCaixa = ({ pessoa_id, fundo_inicial }) => {
    pessoa(pessoa_id);
    exigir(inteiroNaoNegativo(fundo_inicial ?? 0), 'Fundo de troco inválido.');
    exigir(!caixaAberto(), 'Já existe um caixa aberto.');
    const r = db.prepare('INSERT INTO caixas (aberto_por, fundo_inicial) VALUES (?,?)').run(pessoa_id, fundo_inicial ?? 0);
    return L.obterCaixa(r.lastInsertRowid);
  };

  L.movimentarCaixa = ({ pessoa_id, tipo, valor, motivo }) => {
    pessoa(pessoa_id);
    exigir(['sangria', 'reforco'].includes(tipo), 'Tipo de movimento inválido.');
    exigir(inteiroPositivo(valor), 'Valor inválido.');
    const cx = caixaAberto();
    exigir(cx, 'Não há caixa aberto.');
    if (tipo === 'sangria') {
      const esperado = calcularCaixa(cx).dinheiro_esperado;
      exigir(valor <= esperado, `Sangria maior que o dinheiro no caixa (${(esperado / 100).toFixed(2).replace('.', ',')}).`);
    }
    db.prepare('INSERT INTO movimentos_caixa (caixa_id, tipo, valor, motivo, pessoa_id) VALUES (?,?,?,?,?)')
      .run(cx.id, tipo, valor, texto(motivo) ? motivo.trim() : null, pessoa_id);
    return L.obterCaixa(cx.id);
  };

  // conferidos: valores opcionais de pix/débito/crédito conferidos no extrato/maquininha
  L.fecharCaixa = ({ pessoa_id, dinheiro_contado, conferidos, observacao }) => {
    pessoa(pessoa_id);
    exigir(inteiroNaoNegativo(dinheiro_contado), 'Informe o dinheiro contado.');
    const conf = {};
    for (const [m, v] of Object.entries(conferidos || {})) {
      if (v == null || v === '') continue;
      exigir(METODOS_VENDA.includes(m) && m !== 'dinheiro', 'Método conferido inválido.');
      exigir(inteiroNaoNegativo(v), 'Valor conferido inválido.');
      conf[m] = v;
    }
    return transacao(db, () => {
      const cx = caixaAberto();
      exigir(cx, 'Não há caixa aberto.');
      const t = calcularCaixa(cx);
      const diferencas = { dinheiro: dinheiro_contado - t.dinheiro_esperado };
      for (const [m, v] of Object.entries(conf)) diferencas[m] = v - t.por_metodo[m];
      const foto = {
        vendas: t.vendas, canceladas: t.canceladas, total_vendas: t.total_vendas, por_metodo: t.por_metodo,
        sangrias: t.sangrias, reforcos: t.reforcos, conferidos: conf, diferencas,
      };
      db.prepare(`UPDATE caixas SET fechado_em=datetime('now','localtime'), fechado_por=?, dinheiro_esperado=?,
        dinheiro_contado=?, diferenca=?, resumo_json=?, observacao=? WHERE id=?`).run(
        pessoa_id, t.dinheiro_esperado, dinheiro_contado, diferencas.dinheiro, JSON.stringify(foto),
        texto(observacao) ? observacao.trim() : null, cx.id);
      return L.obterCaixa(cx.id);
    });
  };

  L.listarCaixas = ({ de, ate } = {}) => db.prepare(`SELECT id FROM caixas
    WHERE date(aberto_em) BETWEEN ? AND ? ORDER BY id DESC LIMIT 100`)
    .all(de || '0000-01-01', ate || '9999-12-31').map((r) => L.obterCaixa(r.id));

  L.constantes = () => ({ METODOS_COMPRA, METODOS_VENDA, MOTIVOS_PERDA });

  return L;
}

module.exports = { criarLogica, ErroValidacao };
