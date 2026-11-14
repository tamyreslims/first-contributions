// Testes de acesso (PIN, sessão e permissões) direto pela API HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBanco } = require('../src/db');
const { criarServidor } = require('../src/server');

async function subir(opcoes = {}) {
  const db = abrirBanco(':memory:');
  const srv = criarServidor(db, opcoes);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (metodo, url, corpo, token) => {
    const r = await fetch(base + url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, dados: tipo.includes('json') ? await r.json() : await r.arrayBuffer() };
  };
  return { db, srv, api, fechar: () => new Promise((ok) => srv.close(ok)) };
}

test('primeiro uso cria sócio com PIN; só funciona uma vez', async (t) => {
  const { api, fechar } = await subir(); t.after(fechar);
  assert.equal((await api('GET', '/api/inicio')).dados.configurado, false);
  assert.equal((await api('POST', '/api/primeiro-uso', { nome: 'Ana', pin: '12' })).status, 400);
  const r = await api('POST', '/api/primeiro-uso', { nome: 'Ana', pin: '1234' });
  assert.equal(r.status, 201);
  assert.match(r.dados.token, /^[0-9a-f]{64}$/);
  assert.equal(r.dados.pessoa.socio, 1);
  assert.equal((await api('POST', '/api/primeiro-uso', { nome: 'Eve', pin: '0000' })).status, 400);
  const inicio = (await api('GET', '/api/inicio')).dados;
  assert.equal(inicio.configurado, true);
  assert.ok(!JSON.stringify(inicio).includes('pin_hash'));
});

test('rotas exigem login; PIN errado bloqueia após 5 tentativas', async (t) => {
  const { api, fechar } = await subir(); t.after(fechar);
  const { pessoa } = (await api('POST', '/api/primeiro-uso', { nome: 'Ana', pin: '1234' })).dados;
  assert.equal((await api('GET', '/api/produtos')).status, 401);
  assert.equal((await api('GET', '/api/produtos', null, 'f'.repeat(64))).status, 401);

  for (let i = 1; i <= 4; i++) {
    const r = await api('POST', '/api/login', { pessoa_id: pessoa.id, pin: '9999' });
    assert.equal(r.status, 401);
    assert.match(r.dados.erro, new RegExp(`Restam ${5 - i}`));
  }
  assert.equal((await api('POST', '/api/login', { pessoa_id: pessoa.id, pin: '9999' })).status, 429);
  // nem o PIN certo entra durante o bloqueio
  assert.equal((await api('POST', '/api/login', { pessoa_id: pessoa.id, pin: '1234' })).status, 429);
});

test('sessão expira por inatividade e logout invalida o token', async (t) => {
  let relogio = 1_000_000;
  const { api, fechar } = await subir({ sessaoMinutos: 10, relogio: () => relogio }); t.after(fechar);
  const { token } = (await api('POST', '/api/primeiro-uso', { nome: 'Ana', pin: '1234' })).dados;
  relogio += 9 * 60_000;
  assert.equal((await api('GET', '/api/eu', null, token)).status, 200); // uso renova o prazo
  relogio += 9 * 60_000;
  assert.equal((await api('GET', '/api/eu', null, token)).status, 200);
  relogio += 11 * 60_000;
  assert.equal((await api('GET', '/api/eu', null, token)).status, 401);

  const { token: t2 } = (await api('POST', '/api/login', { pessoa_id: 1, pin: '1234' })).dados;
  await api('POST', '/api/logout', null, t2);
  assert.equal((await api('GET', '/api/eu', null, t2)).status, 401);
});

test('vendedor: vende com o próprio id, não vê custo, não cancela nem faz sangria', async (t) => {
  const { api, fechar } = await subir(); t.after(fechar);
  const socio = (await api('POST', '/api/primeiro-uso', { nome: 'Ana', pin: '1234' })).dados.token;
  assert.equal((await api('POST', '/api/pessoas', { nome: 'Caio', vendedor: true }, socio)).status, 400); // sem PIN
  const caio = (await api('POST', '/api/pessoas', { nome: 'Caio', vendedor: true, pin: '4321' }, socio)).dados;
  const prod = (await api('POST', '/api/produtos', { nome: 'Gelo', preco_venda: 1000 }, socio)).dados;
  await api('POST', '/api/compras', { metodo_pagamento: 'pix', pago_por: 1, itens: [{ produto_id: prod.id, quantidade: 5, custo_unitario: 400 }] }, socio);

  const vend = (await api('POST', '/api/login', { pessoa_id: caio.id, pin: '4321' })).dados.token;
  const produtos = (await api('GET', '/api/produtos', null, vend)).dados;
  assert.equal(produtos[0].estoque, 5);
  assert.equal(produtos[0].custo_medio_estoque, undefined);
  assert.equal(produtos[0].lucro_unitario, undefined);

  for (const [m, u, c] of [['GET', '/api/relatorios/resumo'], ['GET', '/api/planilhas/estoque'], ['POST', '/api/produtos', { nome: 'X', preco_venda: 1 }],
    ['POST', '/api/compras', {}], ['GET', '/api/vendas'], ['POST', '/api/pessoas', { nome: 'Z', vendedor: true, pin: '1111' }]]) {
    assert.equal((await api(m, u, c, vend)).status, 403, `${m} ${u}`);
  }

  assert.equal((await api('POST', '/api/caixa/abrir', { fundo_inicial: 2000 }, vend)).status, 201);
  // tenta vender em nome da Ana: o servidor usa o id da sessão
  const venda = (await api('POST', '/api/vendas', { vendedor_id: 1, itens: [{ produto_id: prod.id, quantidade: 1 }], pagamentos: [{ metodo: 'pix', valor: 1000 }] }, vend)).dados;
  assert.equal(venda.vendedor_id, caio.id);
  assert.equal((await api('POST', `/api/vendas/${venda.id}/cancelar`, {}, vend)).status, 403);
  assert.equal((await api('POST', '/api/caixa/movimento', { tipo: 'sangria', valor: 500 }, vend)).status, 403);
  assert.equal((await api('POST', '/api/caixa/movimento', { tipo: 'reforco', valor: 500 }, vend)).status, 201);
  assert.equal((await api('POST', `/api/vendas/${venda.id}/cancelar`, {}, socio)).status, 201);
  const fechado = await api('POST', '/api/caixa/fechar', { dinheiro_contado: 2500 }, vend);
  assert.equal(fechado.status, 201);
  assert.equal(fechado.dados.fechado_por, caio.id);
});

test('sócio redefine PIN de outra pessoa (derruba sessão); troca do próprio PIN', async (t) => {
  const { api, fechar } = await subir(); t.after(fechar);
  const socio = (await api('POST', '/api/primeiro-uso', { nome: 'Ana', pin: '1234' })).dados.token;
  const caio = (await api('POST', '/api/pessoas', { nome: 'Caio', vendedor: true, pin: '4321' }, socio)).dados;
  const vend = (await api('POST', '/api/login', { pessoa_id: caio.id, pin: '4321' })).dados.token;
  await api('PUT', `/api/pessoas/${caio.id}`, { nome: 'Caio', vendedor: true, pin: '5555' }, socio);
  assert.equal((await api('GET', '/api/eu', null, vend)).status, 401);
  assert.equal((await api('POST', '/api/login', { pessoa_id: caio.id, pin: '5555' })).status, 201);

  assert.equal((await api('POST', '/api/eu/pin', { atual: '0000', novo: '2222' }, socio)).status, 400);
  assert.equal((await api('POST', '/api/eu/pin', { atual: '1234', novo: '2222' }, socio)).status, 201);
  assert.equal((await api('POST', '/api/login', { pessoa_id: 1, pin: '2222' })).status, 201);
  // não pode remover o último sócio
  assert.equal((await api('PUT', '/api/pessoas/1', { nome: 'Ana', vendedor: true, socio: false }, socio)).status, 400);
});

test('cadastro antigo sem PIN cria o PIN no primeiro acesso', async (t) => {
  const { db, api, fechar } = await subir(); t.after(fechar);
  db.prepare("INSERT INTO pessoas (nome, socio, vendedor) VALUES ('Velho', 1, 1)").run();
  const inicio = (await api('GET', '/api/inicio')).dados;
  assert.equal(inicio.pessoas[0].tem_pin, 0);
  const r = await api('POST', '/api/login', { pessoa_id: 1, pin: '7777' });
  assert.equal(r.status, 201);
  assert.equal(r.dados.pin_criado, true);
  assert.equal((await api('POST', '/api/login', { pessoa_id: 1, pin: '1111' })).status, 401);
});
