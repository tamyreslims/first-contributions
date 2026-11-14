const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { criarLogica } = require('../src/logica');

function preparar() {
  const L = criarLogica(abrirBanco(':memory:'));
  const ana = L.salvarPessoa({ nome: 'Ana', socio: true, vendedor: true });
  const bruno = L.salvarPessoa({ nome: 'Bruno', socio: true, vendedor: false });
  const caio = L.salvarPessoa({ nome: 'Caio', socio: false, vendedor: true });
  const cerveja = L.salvarProduto({ nome: 'Cerveja lata', preco_venda: 600, estoque_minimo: 5 });
  const agua = L.salvarProduto({ nome: 'Água', preco_venda: 300 });
  L.abrirCaixa({ pessoa_id: ana.id, fundo_inicial: 5000 });
  return { L, ana, bruno, caio, cerveja, agua };
}

test('compra rateia custos extras proporcionalmente ao valor', () => {
  const { L, ana, cerveja, agua } = preparar();
  const c = L.registrarCompra({
    metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [
      { produto_id: cerveja.id, quantidade: 10, custo_unitario: 300 }, // 3000
      { produto_id: agua.id, quantidade: 10, custo_unitario: 100 },    // 1000
    ],
    extras: [{ descricao: 'Frete', valor: 400 }],
  });
  assert.equal(c.total_itens, 4000);
  assert.equal(c.total_extras, 400);
  const lc = c.itens.find((i) => i.produto_id === cerveja.id);
  const la = c.itens.find((i) => i.produto_id === agua.id);
  assert.equal(lc.custo_final, 330); // 300 de frete / 10
  assert.equal(la.custo_final, 110); // 100 de frete / 10
});

test('venda baixa do lote que vence primeiro (FEFO) e calcula lucro', () => {
  const { L, ana, cerveja } = preparar();
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 5, custo_unitario: 400, validade: '2027-06-01' }] });
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 5, custo_unitario: 300, validade: '2027-01-01' }] });

  const v = L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: cerveja.id, quantidade: 7 }],
    pagamentos: [{ metodo: 'pix', valor: 4200 }] });
  // 5 do lote que vence em jan (300) + 2 do lote de jun (400)
  assert.equal(v.custo_total, 5 * 300 + 2 * 400);
  assert.equal(v.total, 4200);
  assert.equal(v.lucro, 4200 - 2300);
  assert.equal(L.listarProdutos().find((p) => p.id === cerveja.id).estoque, 3);
});

test('não vende sem estoque e não altera nada', () => {
  const { L, ana, cerveja } = preparar();
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 2, custo_unitario: 300 }] });
  assert.throws(() => L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: cerveja.id, quantidade: 3 }],
    pagamentos: [{ metodo: 'pix', valor: 1800 }] }), /Estoque insuficiente/);
  assert.equal(L.listarProdutos().find((p) => p.id === cerveja.id).estoque, 2);
  assert.equal(L.listarVendas().length, 0);
});

test('pagamento dividido com troco em dinheiro', () => {
  const { L, ana, caio, cerveja } = preparar();
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 10, custo_unitario: 300 }] });
  const v = L.registrarVenda({ vendedor_id: caio.id, itens: [{ produto_id: cerveja.id, quantidade: 3 }],
    pagamentos: [{ metodo: 'pix', valor: 1000 }, { metodo: 'dinheiro', valor: 1000 }] });
  assert.equal(v.total, 1800);
  assert.equal(v.troco, 200);
  const din = v.pagamentos.find((p) => p.metodo === 'dinheiro');
  assert.equal(din.valor, 800);
  assert.throws(() => L.registrarVenda({ vendedor_id: caio.id, itens: [{ produto_id: cerveja.id, quantidade: 1 }],
    pagamentos: [{ metodo: 'pix', valor: 1000 }] }), /Troco/);
});

test('sócio que não é vendedor não pode vender; vendedor não pode pagar compra', () => {
  const { L, bruno, caio, cerveja } = preparar();
  assert.throws(() => L.registrarVenda({ vendedor_id: bruno.id, itens: [{ produto_id: cerveja.id, quantidade: 1 }],
    pagamentos: [{ metodo: 'pix', valor: 600 }] }), /vendedor/);
  assert.throws(() => L.registrarCompra({ metodo_pagamento: 'pix', pago_por: caio.id,
    itens: [{ produto_id: cerveja.id, quantidade: 1, custo_unitario: 100 }] }), /socio/);
});

test('cancelar venda devolve ao estoque e sai do relatório', () => {
  const { L, ana, cerveja } = preparar();
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 10, custo_unitario: 300 }] });
  const v = L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: cerveja.id, quantidade: 4 }],
    pagamentos: [{ metodo: 'debito', valor: 2400 }] });
  L.cancelarVenda(v.id, ana.id);
  assert.equal(L.listarProdutos().find((p) => p.id === cerveja.id).estoque, 10);
  assert.equal(L.resumo().faturamento, 0);
  assert.throws(() => L.cancelarVenda(v.id, ana.id), /já cancelada/);
});

test('perdas e despesas entram no lucro final; acerto de sócios', () => {
  const { L, ana, bruno, cerveja } = preparar();
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 10, custo_unitario: 300 }] }); // Ana: 3000
  L.registrarDespesa({ descricao: 'Energia', valor: 1000, metodo_pagamento: 'pix', pago_por: bruno.id }); // Bruno: 1000
  L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: cerveja.id, quantidade: 5 }],
    pagamentos: [{ metodo: 'pix', valor: 3000 }] });
  L.registrarPerda({ produto_id: cerveja.id, quantidade: 1, motivo: 'quebrado' });

  const r = L.resumo();
  assert.equal(r.faturamento, 3000);
  assert.equal(r.lucro_bruto, 1500);
  assert.equal(r.perdas, 300);
  assert.equal(r.despesas, 1000);
  assert.equal(r.lucro_final, 200);

  const s = L.acertoSocios();
  assert.equal(s.total_investido, 4000);
  assert.equal(s.socios.find((x) => x.nome === 'Ana').saldo, 1000);   // tem a receber
  assert.equal(s.socios.find((x) => x.nome === 'Bruno').saldo, -1000); // deve
});

test('alertas de estoque baixo e vencimento', () => {
  const { L, ana, cerveja } = preparar();
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 3, custo_unitario: 300, validade: amanha }] });
  const a = L.alertas(7);
  assert.ok(a.estoque_baixo.some((p) => p.id === cerveja.id));
  assert.equal(a.vencendo.length, 1);
});

test('caixa: venda exige caixa aberto; só um caixa aberto por vez', () => {
  const L = criarLogica(abrirBanco(':memory:'));
  const ana = L.salvarPessoa({ nome: 'Ana', socio: true, vendedor: true });
  const p = L.salvarProduto({ nome: 'Gelo', preco_venda: 1000 });
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id, itens: [{ produto_id: p.id, quantidade: 5, custo_unitario: 400 }] });
  assert.throws(() => L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: p.id, quantidade: 1 }],
    pagamentos: [{ metodo: 'pix', valor: 1000 }] }), /caixa está fechado/);
  L.abrirCaixa({ pessoa_id: ana.id, fundo_inicial: 0 });
  assert.throws(() => L.abrirCaixa({ pessoa_id: ana.id, fundo_inicial: 0 }), /Já existe/);
});

test('caixa: fechamento calcula esperado, sobra/falta e conferência de cartão', () => {
  const { L, ana, caio, cerveja } = preparar(); // caixa aberto com fundo de R$ 50
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id,
    itens: [{ produto_id: cerveja.id, quantidade: 20, custo_unitario: 300 }] });
  // dinheiro: 1800 (pagou 2000, troco 200)
  L.registrarVenda({ vendedor_id: caio.id, itens: [{ produto_id: cerveja.id, quantidade: 3 }], pagamentos: [{ metodo: 'dinheiro', valor: 2000 }] });
  L.registrarVenda({ vendedor_id: caio.id, itens: [{ produto_id: cerveja.id, quantidade: 2 }], pagamentos: [{ metodo: 'debito', valor: 1200 }] });
  const cancelada = L.registrarVenda({ vendedor_id: caio.id, itens: [{ produto_id: cerveja.id, quantidade: 1 }], pagamentos: [{ metodo: 'dinheiro', valor: 600 }] });
  L.cancelarVenda(cancelada.id, ana.id);
  L.movimentarCaixa({ pessoa_id: ana.id, tipo: 'reforco', valor: 1000, motivo: 'troco' });
  L.movimentarCaixa({ pessoa_id: ana.id, tipo: 'sangria', valor: 3000, motivo: 'depósito' });
  assert.throws(() => L.movimentarCaixa({ pessoa_id: ana.id, tipo: 'sangria', valor: 999999 }), /maior que o dinheiro/);

  const atual = L.caixaAtual();
  // 5000 fundo + 1800 vendas + 1000 reforço - 3000 sangria
  assert.equal(atual.dinheiro_esperado, 4800);
  assert.equal(atual.por_metodo.debito, 1200);
  assert.equal(atual.vendas, 2);
  assert.equal(atual.canceladas, 1);

  const f = L.fecharCaixa({ pessoa_id: ana.id, dinheiro_contado: 4750, conferidos: { debito: 1200, pix: '' } });
  assert.equal(f.aberto, false);
  assert.equal(f.diferenca, -50); // faltou R$ 0,50
  assert.equal(f.diferencas.debito, 0);
  assert.equal(f.diferencas.pix, undefined);
  assert.equal(L.caixaAtual(), null);
  assert.equal(L.listarCaixas().length, 1);

  // venda de caixa fechado não pode ser cancelada
  const vendaFechada = L.listarVendas().find((v) => !v.cancelada);
  assert.throws(() => L.cancelarVenda(vendaFechada.id, ana.id), /caixa já fechado/);
  assert.throws(() => L.fecharCaixa({ pessoa_id: ana.id, dinheiro_contado: 0 }), /Não há caixa/);
});

test('migração adiciona caixa_id em banco antigo', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gel-')), 'velho.db');
  const velho = new DatabaseSync(arq);
  velho.exec(`CREATE TABLE pessoas (id INTEGER PRIMARY KEY, nome TEXT, socio INT, vendedor INT, ativo INT);
    CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, vendedor_id INT, subtotal INT, desconto INT, total INT,
      custo_total REAL, recebido INT, troco INT, cancelada INT DEFAULT 0, cancelada_em TEXT, cancelada_por INT);`);
  velho.close();
  const db = abrirBanco(arq);
  assert.ok(db.prepare('PRAGMA table_info(vendas)').all().some((c) => c.name === 'caixa_id'));
});

test('planilha de estoque: movimento reconstrói estoque inicial/final do período', () => {
  const { dadosEstoque } = require('../src/planilhas');
  const { gerarXlsx } = require('../src/xlsx');
  const db = abrirBanco(':memory:');
  const L = criarLogica(db);
  const ana = L.salvarPessoa({ nome: 'Ana', socio: true, vendedor: true });
  const p = L.salvarProduto({ nome: 'Cerveja <Lata> & Cia', preco_venda: 600 });
  L.abrirCaixa({ pessoa_id: ana.id, fundo_inicial: 0 });
  // ontem: entrada de 10 e venda de 2
  L.registrarCompra({ metodo_pagamento: 'pix', pago_por: ana.id, itens: [{ produto_id: p.id, quantidade: 10, custo_unitario: 300 }] });
  L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: p.id, quantidade: 2 }], pagamentos: [{ metodo: 'pix', valor: 1200 }] });
  db.exec("UPDATE compras SET data=datetime('now','localtime','-1 day'); UPDATE vendas SET data=datetime('now','localtime','-1 day')");
  // hoje: venda de 3 e perda de 1
  L.registrarVenda({ vendedor_id: ana.id, itens: [{ produto_id: p.id, quantidade: 3 }], pagamentos: [{ metodo: 'pix', valor: 1800 }] });
  L.registrarPerda({ produto_id: p.id, quantidade: 1, motivo: 'quebrado' });

  const hoje = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const ontem = db.prepare("SELECT date('now','localtime','-1 day') AS d").get().d;
  const [atual, mov, lotes] = dadosEstoque(db, L, { de: hoje, ate: hoje });
  assert.equal(atual.linhas[0].estoque, 4);
  assert.equal(atual.linhas[0].valor_custo, 12);
  const m = mov.linhas[0];
  assert.deepEqual([m.inicio, m.entradas, m.vendidos, m.perdas, m.fim], [8, 0, 3, 1, 4]);
  assert.equal(m.faturamento, 18);
  assert.equal(m.lucro, 9);
  // só ontem: começa em 0, termina em 8
  const m2 = dadosEstoque(db, L, { de: ontem, ate: ontem })[1].linhas[0];
  assert.deepEqual([m2.inicio, m2.entradas, m2.vendidos, m2.fim], [0, 10, 2, 8]);
  assert.equal(lotes.linhas[0].restante, 4);

  const buf = gerarXlsx(dadosEstoque(db, L, {}));
  assert.equal(buf.readUInt32LE(0), 0x04034b50); // assinatura ZIP
});
