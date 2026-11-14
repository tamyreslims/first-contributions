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

// Campos de custo/lucro que vendedores não veem
const CAMPOS_CUSTO = ['ultimo_custo', 'custo_medio_estoque', 'lucro_unitario', 'margem'];
const semCusto = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !CAMPOS_CUSTO.includes(k)));

function criarServidor(db, opcoes = {}) {
  const L = criarLogica(db, opcoes);
  const PUB = { publica: true };
  const SOCIO = { socio: true };

  // [método, padrão, handler(params, corpo, query, usuario, token), opções]
  // Sem opções: precisa estar logado. PUB: aberta. SOCIO: só sócios.
  const rotas = [
    // ---- acesso ----
    ['GET', '/api/inicio', () => ({
      configurado: L.temPessoas(),
      pessoas: L.listarPessoas().filter((p) => p.ativo).map(({ id, nome, socio, vendedor, tem_pin }) => ({ id, nome, socio, vendedor, tem_pin })),
    }), PUB],
    ['POST', '/api/primeiro-uso', (_, b) => L.configurarPrimeiroUso(b), PUB],
    ['POST', '/api/login', (_, b) => L.login(b), PUB],
    ['POST', '/api/logout', (_, __, ___, ____, token) => L.logout(token)],
    ['GET', '/api/eu', (_, __, ___, u) => u],
    ['POST', '/api/eu/pin', (_, b, __, u) => L.trocarPin(u.id, b)],
    ['GET', '/api/constantes', () => L.constantes()],

    // ---- cadastros (sócio) ----
    ['GET', '/api/pessoas', () => L.listarPessoas()],
    ['POST', '/api/pessoas', (_, b) => {
      if (!b.pin) throw Object.assign(new Error('Defina um PIN de 4 números para a pessoa.'), { status: 400 });
      return L.salvarPessoa(b);
    }, SOCIO],
    ['PUT', '/api/pessoas/:id', (p, b) => L.salvarPessoa(b, p.id), SOCIO],
    ['GET', '/api/produtos', (_, __, ___, u) => (u.socio ? L.listarProdutos() : L.listarProdutos().map(semCusto))],
    ['POST', '/api/produtos', (_, b) => L.salvarProduto(b), SOCIO],
    ['PUT', '/api/produtos/:id', (p, b) => L.salvarProduto(b, p.id), SOCIO],
    ['GET', '/api/tipos-custo', () => L.listarTiposCusto(), SOCIO],
    ['POST', '/api/tipos-custo', (_, b) => L.salvarTipoCusto(b), SOCIO],
    ['PUT', '/api/tipos-custo/:id', (p, b) => L.salvarTipoCusto(b, p.id), SOCIO],
    ['DELETE', '/api/tipos-custo/:id', (p) => L.excluirTipoCusto(p.id), SOCIO],

    // ---- entradas, perdas, despesas (sócio) ----
    ['GET', '/api/compras', (_, __, q) => L.listarCompras(q), SOCIO],
    ['POST', '/api/compras', (_, b) => L.registrarCompra(b), SOCIO],
    ['GET', '/api/perdas', (_, __, q) => L.listarPerdas(q), SOCIO],
    ['POST', '/api/perdas', (_, b, __, u) => L.registrarPerda({ ...b, registrado_por: u.id }), SOCIO],
    ['GET', '/api/despesas', (_, __, q) => L.listarDespesas(q), SOCIO],
    ['POST', '/api/despesas', (_, b) => L.registrarDespesa(b), SOCIO],

    // ---- vendas ----
    ['POST', '/api/vendas', (_, b, __, u) => L.registrarVenda({ ...b, vendedor_id: u.id })],
    ['GET', '/api/vendas', (_, __, q) => L.listarVendas({ ...q, vendedor_id: q.vendedor_id ? Number(q.vendedor_id) : undefined }), SOCIO],
    ['POST', '/api/vendas/:id/cancelar', (p, _, __, u) => L.cancelarVenda(p.id, u.id), SOCIO],

    // ---- relatórios (sócio) ----
    ['GET', '/api/relatorios/resumo', (_, __, q) => L.resumo(q), SOCIO],
    ['GET', '/api/relatorios/socios', (_, __, q) => L.acertoSocios(q), SOCIO],
    ['GET', '/api/planilhas/estoque', (_, __, q) => ({
      arquivo: planilhaEstoque(db, L, q),
      nome: `geladao-estoque_${q.de && q.de !== '0000-01-01' ? q.de : 'inicio'}_a_${q.ate && q.ate !== '9999-12-31' ? q.ate : 'hoje'}.xlsx`,
    }), SOCIO],
    ['GET', '/api/alertas', (_, __, q, u) => {
      const a = L.alertas(q.dias ? Number(q.dias) : 7);
      return u.socio ? a : { ...a, estoque_baixo: a.estoque_baixo.map(semCusto) };
    }],

    // ---- caixa: vendedor abre, reforça e fecha; sangria só sócio ----
    ['GET', '/api/caixa', () => L.caixaAtual()],
    ['GET', '/api/caixas', (_, __, q) => L.listarCaixas(q)],
    ['GET', '/api/caixas/:id', (p) => L.obterCaixa(p.id)],
    ['POST', '/api/caixa/abrir', (_, b, __, u) => L.abrirCaixa({ ...b, pessoa_id: u.id })],
    ['POST', '/api/caixa/movimento', (_, b, __, u) => {
      if (b.tipo === 'sangria' && !u.socio) throw Object.assign(new Error('Só sócios podem fazer sangria.'), { status: 403 });
      return L.movimentarCaixa({ ...b, pessoa_id: u.id });
    }],
    ['POST', '/api/caixa/fechar', (_, b, __, u) => L.fecharCaixa({ ...b, pessoa_id: u.id })],
  ].map(([m, padrao, h, op = {}]) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '(\\d+)'; }) + '$');
    return { m, re, nomes, h, ...op };
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
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      let usuario = null;
      if (!rota.publica) {
        usuario = L.sessao(token);
        if (!usuario) return responder(res, 401, { erro: 'Sessão expirada. Digite seu PIN.', sessao: false });
        if (rota.socio && !usuario.socio) return responder(res, 403, { erro: 'Apenas sócios podem fazer isso.' });
      }
      const corpo = ['POST', 'PUT'].includes(req.method) ? await lerCorpo(req) : {};
      const resultado = rota.h(params, corpo, Object.fromEntries(url.searchParams), usuario, token);
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
  criarServidor(db, { sessaoMinutos: process.env.SESSAO_MINUTOS }).listen(porta, '0.0.0.0', () => {
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
