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
