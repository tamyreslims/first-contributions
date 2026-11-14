// Monta as planilhas de relatório. Valores convertidos de centavos para reais.

const { gerarXlsx } = require('./xlsx');

const R = (c) => (c == null ? null : Math.round(c) / 100);
const dataBR = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');

function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dadosEstoque(db, L, { de, ate } = {}) {
  const a = /^\d{4}-\d{2}-\d{2}$/.test(de || '') ? de : '0000-01-01';
  const b = /^\d{4}-\d{2}-\d{2}$/.test(ate || '') ? ate : '9999-12-31';
  const hoje = hojeLocal();
  const produtos = L.listarProdutos();

  // ---- Aba 1: estoque atual ----
  const atual = produtos.filter((p) => p.ativo || p.estoque > 0).map((p) => {
    const custo = p.custo_medio_estoque ?? p.ultimo_custo;
    return {
      produto: p.nome, categoria: p.categoria || '', estoque: p.estoque, minimo: p.estoque_minimo,
      situacao: p.estoque === 0 ? 'Zerado' : p.estoque <= p.estoque_minimo ? 'Baixo' : 'OK',
      custo: R(custo), preco: R(p.preco_venda), lucro: R(p.lucro_unitario), margem: p.margem,
      valor_custo: custo == null ? null : R(custo * p.estoque), valor_venda: R(p.preco_venda * p.estoque),
      validade: p.proxima_validade || '',
    };
  });
  const soma = (lista, campo) => Math.round(lista.reduce((s, x) => s + (x[campo] || 0), 0) * 100) / 100;

  // ---- Aba 2: movimento no período ----
  // Quantidades por produto em um intervalo de datas
  const q = {
    entradas: db.prepare(`SELECT l.produto_id AS id, SUM(l.quantidade) AS qtd, SUM(l.quantidade*l.custo_final) AS valor
      FROM lotes l JOIN compras c ON c.id=l.compra_id WHERE date(c.data) BETWEEN ? AND ? GROUP BY l.produto_id`),
    vendas: db.prepare(`SELECT vi.produto_id AS id, SUM(vi.quantidade) AS qtd, SUM(vi.quantidade*vi.preco_unitario) AS valor,
      SUM(vi.custo_total) AS custo FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id
      WHERE v.cancelada=0 AND date(v.data) BETWEEN ? AND ? GROUP BY vi.produto_id`),
    perdas: db.prepare(`SELECT produto_id AS id, SUM(quantidade) AS qtd, SUM(custo_total) AS custo
      FROM perdas WHERE date(data) BETWEEN ? AND ? GROUP BY produto_id`),
  };
  const mapa = (rows) => new Map(rows.map((r) => [r.id, r]));
  const noPeriodo = { e: mapa(q.entradas.all(a, b)), v: mapa(q.vendas.all(a, b)), p: mapa(q.perdas.all(a, b)) };
  // Movimentos depois do fim do período, para reconstruir o estoque daquela data
  const dia = (s) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const depoisDe = b >= '9999-12-31' ? null : dia(b);
  const depois = depoisDe
    ? { e: mapa(q.entradas.all(depoisDe, '9999-12-31')), v: mapa(q.vendas.all(depoisDe, '9999-12-31')), p: mapa(q.perdas.all(depoisDe, '9999-12-31')) }
    : { e: new Map(), v: new Map(), p: new Map() };
  const qt = (m, id) => m.get(id)?.qtd || 0;

  const movimento = produtos.map((p) => {
    const ent = qt(noPeriodo.e, p.id), ven = qt(noPeriodo.v, p.id), per = qt(noPeriodo.p, p.id);
    const fim = p.estoque - qt(depois.e, p.id) + qt(depois.v, p.id) + qt(depois.p, p.id);
    const inicio = fim - ent + ven + per;
    const vend = noPeriodo.v.get(p.id);
    return {
      produto: p.nome, categoria: p.categoria || '', inicio, entradas: ent, vendidos: ven, perdas: per, fim,
      custo_entradas: R(noPeriodo.e.get(p.id)?.valor), faturamento: R(vend?.valor), custo_vendido: R(vend?.custo),
      lucro: vend ? R(vend.valor - vend.custo) : null, custo_perdas: R(noPeriodo.p.get(p.id)?.custo),
    };
  }).filter((m) => m.inicio || m.entradas || m.vendidos || m.perdas || m.fim);

  // ---- Aba 3: lotes com saldo ----
  const lotes = db.prepare(`SELECT l.*, pr.nome AS produto, c.data AS data_compra, pe.nome AS pago_por
    FROM lotes l JOIN produtos pr ON pr.id=l.produto_id JOIN compras c ON c.id=l.compra_id JOIN pessoas pe ON pe.id=c.pago_por
    WHERE l.quantidade_restante > 0 ORDER BY l.validade IS NULL, l.validade, pr.nome`).all().map((l) => {
    const dias = l.validade ? Math.round((Date.parse(l.validade) - Date.parse(hoje)) / 86400000) : null;
    return {
      produto: l.produto, entrada: l.data_compra.slice(0, 10), pago_por: l.pago_por, comprado: l.quantidade, restante: l.quantidade_restante,
      custo_pago: R(l.custo_unitario), rateio: R(l.rateio_unitario), custo_final: R(l.custo_final),
      valor_restante: R(l.custo_final * l.quantidade_restante), validade: l.validade || '', dias,
      situacao: dias == null ? 'Sem validade' : dias < 0 ? 'VENCIDO' : dias <= 7 ? 'Vence em breve' : 'OK',
    };
  });

  const periodoTxt = a === '0000-01-01' && b === '9999-12-31' ? 'todo o período' : `${dataBR(a)} a ${dataBR(b)}`;
  return [
    {
      nome: 'Estoque atual', titulo: `Estoque atual — gerado em ${dataBR(hoje)}`,
      colunas: [
        { titulo: 'Produto', campo: 'produto', tipo: 'texto', largura: 28 },
        { titulo: 'Categoria', campo: 'categoria', tipo: 'texto', largura: 16 },
        { titulo: 'Estoque', campo: 'estoque', tipo: 'int', largura: 10 },
        { titulo: 'Mínimo', campo: 'minimo', tipo: 'int', largura: 10 },
        { titulo: 'Situação', campo: 'situacao', tipo: 'texto', largura: 11 },
        { titulo: 'Custo médio un.', campo: 'custo', tipo: 'moeda', largura: 15 },
        { titulo: 'Preço de venda', campo: 'preco', tipo: 'moeda', largura: 15 },
        { titulo: 'Lucro por un.', campo: 'lucro', tipo: 'moeda', largura: 14 },
        { titulo: 'Margem', campo: 'margem', tipo: 'pct', largura: 10 },
        { titulo: 'Valor em estoque (custo)', campo: 'valor_custo', tipo: 'moeda', largura: 18 },
        { titulo: 'Valor em estoque (venda)', campo: 'valor_venda', tipo: 'moeda', largura: 18 },
        { titulo: 'Próxima validade', campo: 'validade', tipo: 'data', largura: 15 },
      ],
      linhas: atual,
      total: { produto: 'TOTAL', estoque: soma(atual, 'estoque'), valor_custo: soma(atual, 'valor_custo'), valor_venda: soma(atual, 'valor_venda') },
    },
    {
      nome: 'Movimento no período', titulo: `Movimento de estoque — ${periodoTxt}`,
      colunas: [
        { titulo: 'Produto', campo: 'produto', tipo: 'texto', largura: 28 },
        { titulo: 'Categoria', campo: 'categoria', tipo: 'texto', largura: 16 },
        { titulo: 'Estoque inicial', campo: 'inicio', tipo: 'int', largura: 12 },
        { titulo: 'Entradas', campo: 'entradas', tipo: 'int', largura: 10 },
        { titulo: 'Vendidos', campo: 'vendidos', tipo: 'int', largura: 10 },
        { titulo: 'Perdas', campo: 'perdas', tipo: 'int', largura: 10 },
        { titulo: 'Estoque final', campo: 'fim', tipo: 'int', largura: 12 },
        { titulo: 'Custo das entradas', campo: 'custo_entradas', tipo: 'moeda', largura: 16 },
        { titulo: 'Faturamento', campo: 'faturamento', tipo: 'moeda', largura: 14 },
        { titulo: 'Custo vendido', campo: 'custo_vendido', tipo: 'moeda', largura: 14 },
        { titulo: 'Lucro', campo: 'lucro', tipo: 'moeda', largura: 14 },
        { titulo: 'Custo das perdas', campo: 'custo_perdas', tipo: 'moeda', largura: 15 },
      ],
      linhas: movimento,
      total: Object.fromEntries([['produto', 'TOTAL'], ...['inicio', 'entradas', 'vendidos', 'perdas', 'fim', 'custo_entradas', 'faturamento', 'custo_vendido', 'lucro', 'custo_perdas']
        .map((c) => [c, soma(movimento, c)])]),
    },
    {
      nome: 'Lotes e validades', titulo: 'Lotes com saldo em estoque (o que vence primeiro sai primeiro)',
      colunas: [
        { titulo: 'Produto', campo: 'produto', tipo: 'texto', largura: 28 },
        { titulo: 'Data da entrada', campo: 'entrada', tipo: 'data', largura: 14 },
        { titulo: 'Pago por', campo: 'pago_por', tipo: 'texto', largura: 14 },
        { titulo: 'Comprado', campo: 'comprado', tipo: 'int', largura: 10 },
        { titulo: 'Restante', campo: 'restante', tipo: 'int', largura: 10 },
        { titulo: 'Custo pago un.', campo: 'custo_pago', tipo: 'moeda', largura: 14 },
        { titulo: 'Custos extras un.', campo: 'rateio', tipo: 'moeda', largura: 15 },
        { titulo: 'Custo final un.', campo: 'custo_final', tipo: 'moeda', largura: 14 },
        { titulo: 'Valor restante', campo: 'valor_restante', tipo: 'moeda', largura: 14 },
        { titulo: 'Validade', campo: 'validade', tipo: 'data', largura: 12 },
        { titulo: 'Dias p/ vencer', campo: 'dias', tipo: 'int', largura: 12 },
        { titulo: 'Situação', campo: 'situacao', tipo: 'texto', largura: 15 },
      ],
      linhas: lotes,
      total: { produto: 'TOTAL', restante: soma(lotes, 'restante'), valor_restante: soma(lotes, 'valor_restante') },
    },
  ];
}

function planilhaEstoque(db, L, periodo) {
  return gerarXlsx(dadosEstoque(db, L, periodo));
}

module.exports = { dadosEstoque, planilhaEstoque };
