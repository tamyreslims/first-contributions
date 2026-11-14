// Servidor HTTP do Geladão: API JSON em /api e o app web (pasta public).
// Sem dependências externas: só Node.js 22+.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { abrirBanco } = require('./db');
const { criarLogica } = require('./logica');
const { planilhaEstoque } = require('./planilhas');

const PUBLIC = path.join(__dirname, '..', 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function criarServidor(db) {
  const L = criarLogica(db);

  // [método, padrão, handler(params, corpo, query)]
  const rotas = [
    ['GET', '/api/constantes', () => L.constantes()],
    ['GET', '/api/pessoas', () => L.listarPessoas()],
    ['POST', '/api/pessoas', (_, b) => L.salvarPessoa(b)],
    ['PUT', '/api/pessoas/:id', (p, b) => L.salvarPessoa(b, p.id)],
    ['GET', '/api/produtos', () => L.listarProdutos()],
    ['POST', '/api/produtos', (_, b) => L.salvarProduto(b)],
    ['PUT', '/api/produtos/:id', (p, b) => L.salvarProduto(b, p.id)],
    ['GET', '/api/tipos-custo', () => L.listarTiposCusto()],
    ['POST', '/api/tipos-custo', (_, b) => L.salvarTipoCusto(b)],
    ['PUT', '/api/tipos-custo/:id', (p, b) => L.salvarTipoCusto(b, p.id)],
    ['DELETE', '/api/tipos-custo/:id', (p) => L.excluirTipoCusto(p.id)],
    ['GET', '/api/compras', (_, __, q) => L.listarCompras(q)],
    ['POST', '/api/compras', (_, b) => L.registrarCompra(b)],
    ['GET', '/api/vendas', (_, __, q) => L.listarVendas({ ...q, vendedor_id: q.vendedor_id ? Number(q.vendedor_id) : undefined })],
    ['POST', '/api/vendas', (_, b) => L.registrarVenda(b)],
    ['POST', '/api/vendas/:id/cancelar', (p, b) => L.cancelarVenda(p.id, b.pessoa_id)],
    ['GET', '/api/perdas', (_, __, q) => L.listarPerdas(q)],
    ['POST', '/api/perdas', (_, b) => L.registrarPerda(b)],
    ['GET', '/api/despesas', (_, __, q) => L.listarDespesas(q)],
    ['POST', '/api/despesas', (_, b) => L.registrarDespesa(b)],
    ['GET', '/api/relatorios/resumo', (_, __, q) => L.resumo(q)],
    ['GET', '/api/relatorios/socios', (_, __, q) => L.acertoSocios(q)],
    ['GET', '/api/caixa', () => L.caixaAtual()],
    ['GET', '/api/caixas', (_, __, q) => L.listarCaixas(q)],
    ['GET', '/api/caixas/:id', (p) => L.obterCaixa(p.id)],
    ['POST', '/api/caixa/abrir', (_, b) => L.abrirCaixa(b)],
    ['POST', '/api/caixa/movimento', (_, b) => L.movimentarCaixa(b)],
    ['POST', '/api/caixa/fechar', (_, b) => L.fecharCaixa(b)],
    ['GET', '/api/planilhas/estoque', (_, __, q) => ({
      arquivo: planilhaEstoque(db, L, q),
      nome: `geladao-estoque_${q.de && q.de !== '0000-01-01' ? q.de : 'inicio'}_a_${q.ate && q.ate !== '9999-12-31' ? q.ate : 'hoje'}.xlsx`,
    })],
    ['GET', '/api/alertas', (_, __, q) => L.alertas(q.dias ? Number(q.dias) : 7)],
  ].map(([m, padrao, h]) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '(\\d+)'; }) + '$');
    return { m, re, nomes, h };
  });

  function responder(res, status, obj) {
    const corpo = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(corpo);
  }

  function lerCorpo(req) {
    return new Promise((ok, falha) => {
      let dados = '';
      req.on('data', (c) => { dados += c; if (dados.length > 1e6) { falha(new Error('Corpo muito grande')); req.destroy(); } });
      req.on('end', () => {
        if (!dados) return ok({});
        try { ok(JSON.parse(dados)); } catch { const e = new Error('JSON inválido'); e.status = 400; falha(e); }
      });
      req.on('error', falha);
    });
  }

  function servirArquivo(req, res, caminho) {
    let rel = decodeURIComponent(caminho);
    if (rel === '/') rel = '/index.html';
    const arquivo = path.normalize(path.join(PUBLIC, rel));
    if (!arquivo.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(arquivo, (err, conteudo) => {
      if (err) {
        // SPA: qualquer rota desconhecida devolve o index
        return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404); return res.end('Não encontrado'); }
          res.writeHead(200, { 'Content-Type': TIPOS['.html'] });
          res.end(idx);
        });
      }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream' });
      res.end(conteudo);
    });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return servirArquivo(req, res, url.pathname);

    const rota = rotas.find((r) => r.m === req.method && r.re.test(url.pathname));
    if (!rota) return responder(res, 404, { erro: 'Rota não encontrada' });
    const match = url.pathname.match(rota.re);
    const params = Object.fromEntries(rota.nomes.map((n, i) => [n, Number(match[i + 1])]));
    try {
      const corpo = ['POST', 'PUT'].includes(req.method) ? await lerCorpo(req) : {};
      const resultado = rota.h(params, corpo, Object.fromEntries(url.searchParams));
      if (resultado && Buffer.isBuffer(resultado.arquivo)) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${resultado.nome}"`,
          'Content-Length': resultado.arquivo.length,
          'Cache-Control': 'no-store',
        });
        return res.end(resultado.arquivo);
      }
      responder(res, req.method === 'POST' ? 201 : 200, resultado);
    } catch (e) {
      if (!e.status) console.error(e);
      responder(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno no servidor' });
    }
  });
}

if (require.main === module) {
  const porta = Number(process.env.PORT) || 3000;
  const arquivoBanco = process.env.DB_FILE || path.join(__dirname, '..', 'dados', 'geladao.db');
  const db = abrirBanco(arquivoBanco);
  criarServidor(db).listen(porta, '0.0.0.0', () => {
    console.log(`\n🧊 Geladão rodando!`);
    console.log(`   Neste computador:  http://localhost:${porta}`);
    for (const lista of Object.values(os.networkInterfaces())) {
      for (const i of lista || []) {
        if (i.family === 'IPv4' && !i.internal) console.log(`   Nos celulares (mesmo Wi-Fi):  http://${i.address}:${porta}`);
      }
    }
    console.log(`   Banco de dados: ${arquivoBanco}\n`);
  });
}

module.exports = { criarServidor };
