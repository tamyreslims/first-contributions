// App web do Geladão (sem frameworks). Valores em centavos.
const App = (() => {
  // ---------- utilidades ----------
  const NOMES_METODO = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Débito', credito: 'Crédito', boleto: 'Boleto', transferencia: 'Transferência' };
  const NOMES_MOTIVO = { vencido: 'Vencido', quebrado: 'Quebrado/estragado', consumo: 'Consumo próprio', outro: 'Outro' };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reais = (c) => (c == null ? '—' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '%');
  // "5,50" | "5.50" | "5" -> 550 centavos (null se inválido)
  function centavos(txt) {
    if (txt == null) return null;
    let s = String(txt).trim().replace(/[R$\s]/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  const paraCampo = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const dataLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dataBR = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') + (s.length > 10 ? ' ' + s.slice(11, 16) : '') : '—');

  async function api(metodo, url, corpo) {
    const r = await fetch(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || 'Falha de comunicação com o servidor');
    return dados;
  }
  let timerAviso;
  function aviso(msg, erro = false) {
    const el = $('#aviso');
    el.textContent = msg; el.className = 'aviso' + (erro ? ' erro' : ''); el.hidden = false;
    clearTimeout(timerAviso); timerAviso = setTimeout(() => (el.hidden = true), erro ? 4500 : 2500);
  }
  async function tentar(fn) { try { return await fn(); } catch (e) { aviso(e.message, true); } }
  function lerLS(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function gravarLS(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

  // ---------- estado ----------
  const S = {
    aba: 'vender', usuario: null, pessoas: [], produtos: [], tiposCusto: [], constantes: null,
    carrinho: [], desconto: 0, pagamentos: [], busca: '',
    entrada: null, periodo: 'hoje', de: null, ate: null,
  };
  const ativos = () => S.produtos.filter((p) => p.ativo);
  const socios = () => S.pessoas.filter((p) => p.ativo && p.socio);
  const produto = (id) => S.produtos.find((p) => p.id === Number(id));

  async function carregarBase() {
    const [pessoas, produtos, tipos, constantes] = await Promise.all([
      api('GET', '/api/pessoas'), api('GET', '/api/produtos'), api('GET', '/api/tipos-custo'),
      S.constantes ? Promise.resolve(S.constantes) : api('GET', '/api/constantes')]);
    Object.assign(S, { pessoas, produtos, tiposCusto: tipos, constantes });
    const id = Number(lerLS('geladao.usuario'));
    S.usuario = pessoas.find((p) => p.id === id && p.ativo) || null;
  }

  function ir(aba) {
    S.aba = aba;
    document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === aba));
    render();
  }

  async function render() {
    $('#btn-usuario').textContent = S.usuario ? '👤 ' + S.usuario.nome : 'Entrar';
    if (!S.pessoas.length) return telaPrimeiroUso();
    if (!S.usuario) return telaLogin();
    const telas = { vender: telaVender, estoque: telaEstoque, entrada: telaEntrada, relatorios: telaRelatorios, mais: telaMais };
    await (telas[S.aba] || telaVender)();
  }

  // ---------- primeiro uso / login ----------
  function telaPrimeiroUso() {
    $('#tela').innerHTML = `<div class="cartao login">
      <h2>Bem-vindo ao Geladão!</h2>
      <p class="suave">Comece cadastrando a primeira pessoa (sócio e vendedor).</p>
      <label>Nome<input id="pu-nome" autofocus></label>
      <button class="btn largo" onclick="App.primeiroUso()">Começar</button></div>`;
  }
  async function primeiroUso() {
    const nome = $('#pu-nome').value;
    await tentar(async () => {
      const p = await api('POST', '/api/pessoas', { nome, socio: true, vendedor: true });
      gravarLS('geladao.usuario', p.id);
      await carregarBase(); ir('mais');
      aviso('Pronto! Agora cadastre os produtos.');
    });
  }
  function telaLogin() {
    const vend = S.pessoas.filter((p) => p.ativo && p.vendedor);
    $('#tela').innerHTML = `<div class="cartao login"><h2>Quem está vendendo?</h2>
      <ul class="lista">${vend.map((p) => `<li><button class="btn sec" onclick="App.entrar(${p.id})">${esc(p.nome)}</button></li>`).join('')}</ul>
      ${vend.length ? '' : '<p class="vazio">Nenhum vendedor ativo.</p>'}</div>`;
  }
  function entrar(id) { gravarLS('geladao.usuario', id); S.usuario = S.pessoas.find((p) => p.id === id); ir('vender'); }
  function trocarUsuario() { gravarLS('geladao.usuario', null); S.usuario = null; S.carrinho = []; render(); }

  // ---------- VENDER ----------
  function totaisVenda() {
    const subtotal = S.carrinho.reduce((s, it) => s + it.quantidade * produto(it.produto_id).preco_venda, 0);
    const total = Math.max(0, subtotal - S.desconto);
    const pago = S.pagamentos.reduce((s, p) => s + (p.valor || 0), 0);
    return { subtotal, total, pago, falta: Math.max(0, total - pago), troco: Math.max(0, pago - total) };
  }

  async function telaVender() {
    [S.produtos, S.caixa] = await Promise.all([api('GET', '/api/produtos'), api('GET', '/api/caixa')]);
    if (!S.usuario.vendedor) {
      $('#tela').innerHTML = `<div class="cartao vazio">${esc(S.usuario.nome)} não está cadastrado(a) como vendedor.<br><br>
        <button class="btn" onclick="App.trocarUsuario()">Trocar de usuário</button></div>`;
      return;
    }
    if (!S.caixa) {
      $('#tela').innerHTML = `<div class="cartao login"><h2>💰 Caixa fechado</h2>
        <p class="suave">Para vender, abra o caixa informando o fundo de troco.</p>
        <button class="btn largo" onclick="App.telaCaixa()">Abrir caixa</button></div>`;
      return;
    }
    $('#tela').innerHTML = `<button class="barra-caixa" onclick="App.telaCaixa()">💰 Caixa aberto · gaveta ${reais(S.caixa.dinheiro_esperado)} · vendas ${reais(S.caixa.total_vendas)} <b>Caixa ›</b></button>
      <div class="layout-venda">
      <section>
        <input id="busca" type="search" placeholder="🔎 Buscar produto..." value="${esc(S.busca)}" oninput="App.buscar(this.value)">
        <div id="grade" class="grade-produtos" style="margin-top:10px"></div>
      </section>
      <section class="cartao" id="carrinho"></section></div>`;
    renderGrade(); renderCarrinho();
  }
  function buscar(v) { S.busca = v; renderGrade(); }
  function renderGrade() {
    const termo = S.busca.trim().toLowerCase();
    const lista = ativos().filter((p) => !termo || p.nome.toLowerCase().includes(termo) || (p.categoria || '').toLowerCase().includes(termo));
    $('#grade').innerHTML = lista.map((p) => {
      const noCarrinho = S.carrinho.find((c) => c.produto_id === p.id)?.quantidade || 0;
      const resta = p.estoque - noCarrinho;
      return `<button class="produto-btn" ${resta <= 0 ? 'disabled' : ''} onclick="App.addCarrinho(${p.id})">
        <strong>${esc(p.nome)}</strong><span class="preco">${reais(p.preco_venda)}</span>
        <div class="suave">${resta} em estoque</div></button>`;
    }).join('') || `<p class="vazio">Nenhum produto. Cadastre em ⚙️ Mais › Produtos.</p>`;
  }
  function addCarrinho(id) {
    const p = produto(id);
    const it = S.carrinho.find((c) => c.produto_id === id);
    const atual = it ? it.quantidade : 0;
    if (atual >= p.estoque) return aviso('Sem estoque suficiente', true);
    if (it) it.quantidade++; else S.carrinho.push({ produto_id: id, quantidade: 1 });
    ajustarPagamentoUnico(); renderGrade(); renderCarrinho();
  }
  function mudarQtd(id, delta) {
    const it = S.carrinho.find((c) => c.produto_id === id);
    if (!it) return;
    if (delta > 0 && it.quantidade >= produto(id).estoque) return aviso('Sem estoque suficiente', true);
    it.quantidade += delta;
    if (it.quantidade <= 0) S.carrinho = S.carrinho.filter((c) => c !== it);
    ajustarPagamentoUnico(); renderGrade(); renderCarrinho();
  }
  // Com uma forma só (e não-dinheiro) o valor acompanha o total automaticamente
  function ajustarPagamentoUnico() {
    if (S.pagamentos.length === 1 && S.pagamentos[0].auto) S.pagamentos[0].valor = totaisVenda().total;
  }
  function escolherMetodo(m) {
    const { total } = totaisVenda();
    S.pagamentos = [{ metodo: m, valor: m === 'dinheiro' ? null : total, auto: m !== 'dinheiro' }];
    renderCarrinho();
    if (m === 'dinheiro') setTimeout(() => $('#pg-0')?.focus(), 0);
  }
  function addPagamento() {
    const { falta } = totaisVenda();
    S.pagamentos.forEach((p) => (p.auto = false));
    S.pagamentos.push({ metodo: 'dinheiro', valor: falta || null, auto: false });
    renderCarrinho();
  }
  function setPagamento(i, campo, v) {
    const p = S.pagamentos[i];
    if (campo === 'valor') { p.valor = centavos(v); p.auto = false; } else p.metodo = v;
    atualizarResumoPagamento();
    if (campo === 'metodo') renderCarrinho();
  }
  function rmPagamento(i) { S.pagamentos.splice(i, 1); renderCarrinho(); }
  function setDesconto(v) { S.desconto = centavos(v) || 0; ajustarPagamentoUnico(); atualizarResumoPagamento(); }

  function renderCarrinho() {
    const t = totaisVenda();
    const metodos = S.constantes.METODOS_VENDA;
    const um = S.pagamentos.length <= 1;
    $('#carrinho').innerHTML = `
      <div class="entre"><h2>Venda</h2>${S.carrinho.length ? '<button class="btn peq perigo" onclick="App.limparVenda()">Limpar</button>' : ''}</div>
      ${S.carrinho.length ? S.carrinho.map((it) => {
        const p = produto(it.produto_id);
        return `<div class="carrinho-item"><div class="nome">${esc(p.nome)}<div class="suave">${reais(p.preco_venda)} un.</div></div>
          <div class="qtd"><button onclick="App.mudarQtd(${p.id},-1)">−</button><b>${it.quantidade}</b><button onclick="App.mudarQtd(${p.id},1)">+</button></div>
          <b style="min-width:80px;text-align:right">${reais(p.preco_venda * it.quantidade)}</b></div>`;
      }).join('') : '<p class="vazio">Toque nos produtos para adicionar.</p>'}
      <label style="margin-top:10px">Desconto (R$)<input inputmode="decimal" value="${paraCampo(S.desconto || null)}" placeholder="0,00" oninput="App.setDesconto(this.value)"></label>
      <div class="entre"><span>Total</span><span class="total-grande" id="v-total">${reais(t.total)}</span></div>

      <h3>Pagamento</h3>
      ${um ? `<div class="metodos">${metodos.map((m) => `<button class="${S.pagamentos[0]?.metodo === m ? 'sel' : ''}" onclick="App.escolherMetodo('${m}')">${NOMES_METODO[m]}</button>`).join('')}</div>` : ''}
      ${S.pagamentos.map((p, i) => `<div class="linha" style="margin-top:8px">
          ${um ? '' : `<select onchange="App.setPagamento(${i},'metodo',this.value)">${metodos.map((m) => `<option value="${m}" ${p.metodo === m ? 'selected' : ''}>${NOMES_METODO[m]}</option>`).join('')}</select>`}
          <label style="margin:0">${um ? (p.metodo === 'dinheiro' ? 'Valor recebido' : 'Valor') : ''}
            <input id="pg-${i}" inputmode="decimal" placeholder="0,00" value="${paraCampo(p.valor)}" oninput="App.setPagamento(${i},'valor',this.value)"></label>
          ${um ? '' : `<button class="btn peq perigo" style="flex:0" onclick="App.rmPagamento(${i})">✕</button>`}
        </div>`).join('')}
      ${S.pagamentos.length ? '<button class="btn peq sec" style="margin-top:8px" onclick="App.addPagamento()">+ Dividir pagamento</button>' : ''}
      <div id="resumo-pg" style="margin:10px 0"></div>
      <button class="btn largo" id="btn-finalizar" onclick="App.finalizarVenda()">Finalizar venda</button>`;
    atualizarResumoPagamento();
  }
  function atualizarResumoPagamento() {
    const t = totaisVenda();
    if ($('#v-total')) $('#v-total').textContent = reais(t.total);
    if (S.pagamentos.length === 1 && S.pagamentos[0].auto && $('#pg-0')) $('#pg-0').value = paraCampo(S.pagamentos[0].valor);
    const el = $('#resumo-pg'); if (!el) return;
    el.innerHTML = !S.pagamentos.length ? '<span class="suave">Escolha a forma de pagamento.</span>'
      : t.falta > 0 ? `<b class="neg">Falta ${reais(t.falta)}</b>`
      : t.troco > 0 ? `<b class="pos" style="font-size:1.2rem">Troco: ${reais(t.troco)}</b>` : '<span class="pos">✔ Pagamento confere</span>';
    $('#btn-finalizar').disabled = !S.carrinho.length || !S.pagamentos.length || t.falta > 0;
  }
  function limparVenda() { S.carrinho = []; S.desconto = 0; S.pagamentos = []; renderGrade(); renderCarrinho(); }
  async function finalizarVenda() {
    const btn = $('#btn-finalizar'); btn.disabled = true;
    await tentar(async () => {
      const v = await api('POST', '/api/vendas', {
        vendedor_id: S.usuario.id, desconto: S.desconto, itens: S.carrinho,
        pagamentos: S.pagamentos.filter((p) => p.valor > 0).map(({ metodo, valor }) => ({ metodo, valor })),
      });
      aviso(`Venda #${v.id} registrada${v.troco ? ' — troco ' + reais(v.troco) : ''} ✔`);
      S.carrinho = []; S.desconto = 0; S.pagamentos = []; S.busca = '';
      await telaVender();
    });
    if ($('#btn-finalizar')) atualizarResumoPagamento();
  }

  // ---------- ESTOQUE ----------
  async function telaEstoque() {
    const [produtos, alertas] = await Promise.all([api('GET', '/api/produtos'), api('GET', '/api/alertas')]);
    S.produtos = produtos;
    const baixo = new Set(alertas.estoque_baixo.map((p) => p.id));
    $('#tela').innerHTML = `<h2>Estoque</h2>
      ${alertas.vencendo.length || alertas.estoque_baixo.length ? `<div class="cartao" style="border-color:var(--amarelo)">
        <b>⚠️ Atenção</b>
        <ul class="lista">
          ${alertas.vencendo.map((l) => `<li>${esc(l.produto_nome)} — ${l.quantidade_restante} un. ${l.dias < 0 ? `<span class="selo erro">venceu ${dataBR(l.validade)}</span>` : `<span class="selo alerta">vence em ${l.dias} dia(s)</span>`}</li>`).join('')}
          ${alertas.estoque_baixo.map((p) => `<li>${esc(p.nome)} — <span class="selo alerta">estoque baixo: ${p.estoque}</span></li>`).join('')}
        </ul></div>` : ''}
      <div class="cartao"><ul class="lista">${ativos().map((p) => `<li>
        <div class="entre"><div><b>${esc(p.nome)}</b>${p.categoria ? `<span class="selo">${esc(p.categoria)}</span>` : ''}
          ${baixo.has(p.id) ? '<span class="selo alerta">baixo</span>' : ''}</div>
          <b style="font-size:1.2rem">${p.estoque}</b></div>
        <div class="suave">Venda ${reais(p.preco_venda)} · Custo ${reais(p.custo_medio_estoque ?? p.ultimo_custo)} ·
          Lucro/un. <span class="${p.lucro_unitario < 0 ? 'neg' : 'pos'}">${reais(p.lucro_unitario)}</span> (${pct(p.margem)})
          · Validade ${dataBR(p.proxima_validade)}</div>
        ${p.estoque > 0 ? `<button class="btn peq perigo" style="margin-top:6px" onclick="App.dialogoPerda(${p.id})">Registrar perda</button>` : ''}
      </li>`).join('') || '<li class="vazio">Nenhum produto cadastrado.</li>'}</ul></div>`;
  }
  function dialogoPerda(id) {
    const p = produto(id);
    abrirDialogo(`<h2>Perda: ${esc(p.nome)}</h2>
      <label>Quantidade (máx. ${p.estoque})<input id="pe-qtd" type="number" min="1" max="${p.estoque}" value="1"></label>
      <label>Motivo<select id="pe-motivo">${S.constantes.MOTIVOS_PERDA.map((m) => `<option value="${m}">${NOMES_MOTIVO[m]}</option>`).join('')}</select></label>
      <div class="linha"><button class="btn sec" onclick="App.fecharDialogo()">Cancelar</button>
      <button class="btn perigo" onclick="App.salvarPerda(${id})">Registrar perda</button></div>`);
  }
  async function salvarPerda(id) {
    await tentar(async () => {
      await api('POST', '/api/perdas', { produto_id: id, quantidade: Number($('#pe-qtd').value), motivo: $('#pe-motivo').value, registrado_por: S.usuario.id });
      fecharDialogo(); aviso('Perda registrada'); telaEstoque();
    });
  }

  // ---------- ENTRADA (compra) ----------
  function novaEntrada() {
    return { fornecedor: '', pago_por: S.usuario.socio ? S.usuario.id : socios()[0]?.id, metodo_pagamento: 'pix',
      itens: [{ produto_id: '', quantidade: '', custo: '', validade: '' }], extras: [] };
  }
  function previaRateio() {
    const E = S.entrada;
    const itens = E.itens.map((i) => ({ ...i, q: Number(i.quantidade) || 0, c: centavos(i.custo) || 0 }));
    const totalItens = itens.reduce((s, i) => s + i.q * i.c, 0);
    const totalQtd = itens.reduce((s, i) => s + i.q, 0);
    const totalExtras = E.extras.reduce((s, e) => s + (centavos(e.valor) || 0), 0);
    return { totalItens, totalExtras, itens: itens.map((i) => {
      if (!i.q) return { final: null };
      const parte = totalItens > 0 ? totalExtras * (i.q * i.c / totalItens) : (totalQtd ? totalExtras * i.q / totalQtd : 0);
      const final = i.c + parte / i.q;
      const p = produto(i.produto_id);
      return { final, lucro: p ? p.preco_venda - final : null };
    }) };
  }
  async function telaEntrada() {
    const [produtos, compras] = await Promise.all([api('GET', '/api/produtos'), api('GET', '/api/compras')]);
    S.produtos = produtos;
    if (!S.entrada) S.entrada = novaEntrada();
    const E = S.entrada;
    if (!socios().length) { $('#tela').innerHTML = '<div class="cartao vazio">Cadastre pelo menos um sócio em ⚙️ Mais › Pessoas.</div>'; return; }
    $('#tela').innerHTML = `<h2>Entrada de mercadoria</h2>
      <div class="cartao">
        <div class="linha">
          <label>Quem pagou<select onchange="App.setEntrada('pago_por', Number(this.value))">${socios().map((s) => `<option value="${s.id}" ${E.pago_por === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select></label>
          <label>Forma de pagamento<select onchange="App.setEntrada('metodo_pagamento', this.value)">${S.constantes.METODOS_COMPRA.map((m) => `<option value="${m}" ${E.metodo_pagamento === m ? 'selected' : ''}>${NOMES_METODO[m]}</option>`).join('')}</select></label>
        </div>
        <label>Fornecedor (opcional)<input value="${esc(E.fornecedor)}" oninput="App.setEntrada('fornecedor', this.value)"></label>
      </div>
      <div class="cartao"><h3 style="margin-top:0">Produtos</h3><div id="ent-itens"></div>
        <button class="btn sec peq" onclick="App.addItemEntrada()">+ Produto</button></div>
      <div class="cartao"><h3 style="margin-top:0">Custos extras <span class="suave">(frete, gelo... divididos entre os produtos)</span></h3><div id="ent-extras"></div>
        <div class="linha">${S.tiposCusto.map((t) => `<button class="btn sec peq" style="flex:0 0 auto" onclick="App.addExtra(${t.id})">+ ${esc(t.nome)}</button>`).join('')}
        <button class="btn sec peq" style="flex:0 0 auto" onclick="App.addExtra()">+ Outro</button></div></div>
      <div class="cartao" id="ent-total"></div>
      <h3>Últimas entradas</h3>
      <div class="cartao"><ul class="lista">${compras.slice(0, 15).map((c) => `<li>
        <div class="entre"><b>${dataBR(c.data)}</b><b>${reais(c.total_itens + c.total_extras)}</b></div>
        <div class="suave">${esc(c.pago_por_nome)} · ${NOMES_METODO[c.metodo_pagamento]}${c.fornecedor ? ' · ' + esc(c.fornecedor) : ''}${c.total_extras ? ' · extras ' + reais(c.total_extras) : ''}</div>
        <div class="suave">${c.itens.map((i) => `${i.quantidade}× ${esc(i.produto_nome)}`).join(', ')}</div></li>`).join('') || '<li class="vazio">Nenhuma entrada ainda.</li>'}</ul></div>`;
    renderItensEntrada(); renderExtras(); renderTotalEntrada();
  }
  function setEntrada(campo, v) { S.entrada[campo] = v; }
  function renderItensEntrada() {
    const prev = previaRateio();
    $('#ent-itens').innerHTML = S.entrada.itens.map((it, i) => `<div style="border-bottom:1px solid var(--borda);padding-bottom:8px;margin-bottom:8px">
      <div class="linha">
        <label style="flex:2 1 200px">Produto<select onchange="App.setItem(${i},'produto_id',this.value)"><option value="">Escolha...</option>
          ${ativos().map((p) => `<option value="${p.id}" ${Number(it.produto_id) === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select></label>
        <label>Quantidade<input type="number" min="1" inputmode="numeric" value="${esc(it.quantidade)}" oninput="App.setItem(${i},'quantidade',this.value)"></label>
        <label>Custo unitário (R$)<input inputmode="decimal" placeholder="0,00" value="${esc(it.custo)}" oninput="App.setItem(${i},'custo',this.value)"></label>
        <label>Validade<input type="date" value="${esc(it.validade)}" onchange="App.setItem(${i},'validade',this.value)"></label>
      </div>
      <div class="entre"><span class="suave" id="prev-${i}">${textoPrevia(prev.itens[i])}</span>
        ${S.entrada.itens.length > 1 ? `<button class="btn peq perigo" onclick="App.rmItem(${i})">Remover</button>` : ''}</div></div>`).join('');
  }
  function textoPrevia(p) {
    if (!p || p.final == null) return '';
    return `Custo final/un.: <b>${reais(Math.round(p.final))}</b>` + (p.lucro != null ? ` · Lucro/un.: <b class="${p.lucro < 0 ? 'neg' : 'pos'}">${reais(Math.round(p.lucro))}</b>` : '');
  }
  function atualizarPrevias() {
    const prev = previaRateio();
    prev.itens.forEach((p, i) => { const el = $('#prev-' + i); if (el) el.innerHTML = textoPrevia(p); });
    renderTotalEntrada();
  }
  function setItem(i, campo, v) { S.entrada.itens[i][campo] = v; atualizarPrevias(); }
  function addItemEntrada() { S.entrada.itens.push({ produto_id: '', quantidade: '', custo: '', validade: '' }); renderItensEntrada(); renderTotalEntrada(); }
  function rmItem(i) { S.entrada.itens.splice(i, 1); renderItensEntrada(); renderTotalEntrada(); }
  function renderExtras() {
    $('#ent-extras').innerHTML = S.entrada.extras.map((e, i) => `<div class="linha">
      <label style="flex:2 1 160px">Descrição<input value="${esc(e.descricao)}" oninput="App.setExtra(${i},'descricao',this.value)"></label>
      <label>Valor (R$)<input inputmode="decimal" placeholder="0,00" value="${esc(e.valor)}" oninput="App.setExtra(${i},'valor',this.value)"></label>
      <button class="btn peq perigo" style="flex:0" onclick="App.rmExtra(${i})">✕</button></div>`).join('');
  }
  function addExtra(tipoId) {
    const t = S.tiposCusto.find((x) => x.id === tipoId);
    S.entrada.extras.push({ descricao: t ? t.nome : '', valor: t && t.valor_padrao ? paraCampo(t.valor_padrao) : '' });
    renderExtras(); atualizarPrevias();
  }
  function setExtra(i, campo, v) { S.entrada.extras[i][campo] = v; atualizarPrevias(); }
  function rmExtra(i) { S.entrada.extras.splice(i, 1); renderExtras(); atualizarPrevias(); }
  function renderTotalEntrada() {
    const p = previaRateio();
    $('#ent-total').innerHTML = `<div class="entre"><span>Produtos</span><b>${reais(p.totalItens)}</b></div>
      <div class="entre"><span>Custos extras</span><b>${reais(p.totalExtras)}</b></div>
      <div class="entre"><span>Total da compra</span><span class="total-grande">${reais(p.totalItens + p.totalExtras)}</span></div>
      <button class="btn largo" style="margin-top:10px" onclick="App.salvarEntrada()">Salvar entrada</button>`;
  }
  async function salvarEntrada() {
    const E = S.entrada;
    const itens = E.itens.filter((i) => i.produto_id || i.quantidade || i.custo).map((i) => ({
      produto_id: Number(i.produto_id), quantidade: Number(i.quantidade), custo_unitario: centavos(i.custo), validade: i.validade || null }));
    if (itens.some((i) => !i.produto_id)) return aviso('Escolha o produto em todas as linhas', true);
    if (itens.some((i) => i.custo_unitario == null)) return aviso('Informe o custo unitário', true);
    const extras = E.extras.filter((e) => e.descricao || e.valor).map((e) => ({ descricao: e.descricao, valor: centavos(e.valor) }));
    await tentar(async () => {
      await api('POST', '/api/compras', { fornecedor: E.fornecedor, pago_por: E.pago_por, metodo_pagamento: E.metodo_pagamento, itens, extras });
      S.entrada = null; aviso('Entrada registrada ✔'); telaEntrada();
    });
  }

  // ---------- RELATÓRIOS ----------
  function intervalo() {
    const hoje = new Date();
    const d = (n) => dataLocal(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - n));
    switch (S.periodo) {
      case 'hoje': return { de: d(0), ate: d(0) };
      case '7d': return { de: d(6), ate: d(0) };
      case 'mes': return { de: dataLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), ate: d(0) };
      case 'mespassado': return { de: dataLocal(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)), ate: dataLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 0)) };
      case 'tudo': return { de: '0000-01-01', ate: '9999-12-31' };
      default: return { de: S.de || d(0), ate: S.ate || d(0) };
    }
  }
  function setPeriodo(p) { S.periodo = p; telaRelatorios(); }
  function setDatas() { S.de = $('#r-de').value; S.ate = $('#r-ate').value; telaRelatorios(); }
  async function telaRelatorios() {
    const { de, ate } = intervalo();
    const q = `?de=${de}&ate=${ate}`;
    const [r, socio, vendas, despesas] = await Promise.all([api('GET', '/api/relatorios/resumo' + q), api('GET', '/api/relatorios/socios' + q),
      api('GET', '/api/vendas' + q), api('GET', '/api/despesas' + q)]);
    const per = { hoje: 'Hoje', '7d': '7 dias', mes: 'Este mês', mespassado: 'Mês passado', tudo: 'Tudo', custom: 'Escolher' };
    $('#tela').innerHTML = `<h2>Relatórios</h2>
      <div class="chips">${Object.entries(per).map(([k, v]) => `<button class="${S.periodo === k ? 'sel' : ''}" onclick="App.setPeriodo('${k}')">${v}</button>`).join('')}</div>
      ${S.periodo === 'custom' ? `<div class="linha"><label>De<input type="date" id="r-de" value="${de}" onchange="App.setDatas()"></label><label>Até<input type="date" id="r-ate" value="${ate}" onchange="App.setDatas()"></label></div>` : ''}
      <div class="kpis">
        <div class="kpi"><div class="suave">Faturamento</div><div class="v">${reais(r.faturamento)}</div><div class="suave">${r.vendas} venda(s)</div></div>
        <div class="kpi"><div class="suave">Custo das mercadorias</div><div class="v">${reais(Math.round(r.custo_mercadoria))}</div></div>
        <div class="kpi"><div class="suave">Lucro bruto</div><div class="v">${reais(Math.round(r.lucro_bruto))}</div></div>
        <div class="kpi"><div class="suave">Perdas</div><div class="v neg">${reais(Math.round(r.perdas))}</div></div>
        <div class="kpi"><div class="suave">Despesas</div><div class="v neg">${reais(r.despesas)}</div></div>
        <div class="kpi destaque"><div class="suave">Lucro final</div><div class="v">${reais(Math.round(r.lucro_final))}</div></div>
      </div>
      <div class="cartao"><h3 style="margin-top:0">Caixa por forma de pagamento</h3><ul class="lista">
        ${r.por_metodo.map((m) => `<li class="entre"><span>${NOMES_METODO[m.metodo]}</span><b>${reais(m.valor)}</b></li>`).join('') || '<li class="vazio">Sem vendas no período.</li>'}</ul></div>
      <div class="cartao"><h3 style="margin-top:0">Por vendedor</h3><ul class="lista">
        ${r.por_vendedor.map((v) => `<li class="entre"><span>${esc(v.nome)} <span class="suave">(${v.vendas})</span></span><span><b>${reais(v.total)}</b> <span class="suave">lucro ${reais(Math.round(v.lucro))}</span></span></li>`).join('') || '<li class="vazio">—</li>'}</ul></div>
      <div class="cartao"><h3 style="margin-top:0">Mais vendidos</h3><ul class="lista">
        ${r.mais_vendidos.map((p) => `<li class="entre"><span>${esc(p.nome)} <span class="suave">× ${p.quantidade}</span></span><span><b>${reais(p.total)}</b> <span class="suave">lucro ${reais(Math.round(p.lucro))}</span></span></li>`).join('') || '<li class="vazio">—</li>'}</ul></div>
      <div class="cartao"><h3 style="margin-top:0">Acerto entre sócios <span class="suave">(compras + despesas pagas no período)</span></h3>
        <div class="suave">Total investido ${reais(socio.total_investido)} · parte de cada ${reais(Math.round(socio.parte_de_cada))}</div>
        <ul class="lista">${socio.socios.map((s) => `<li class="entre"><span>${esc(s.nome)}<div class="suave">pagou ${reais(s.investido)}</div></span>
          <b class="${s.saldo >= 0 ? 'pos' : 'neg'}">${Math.round(s.saldo) === 0 ? 'quite' : s.saldo > 0 ? 'a receber ' + reais(Math.round(s.saldo)) : 'deve ' + reais(Math.round(-s.saldo))}</b></li>`).join('')}</ul></div>
      <div class="cartao"><h3 style="margin-top:0">Vendas</h3><ul class="lista">
        ${vendas.map((v) => `<li class="${v.cancelada ? 'cancelada' : ''}"><div class="entre"><b>#${v.id} · ${dataBR(v.data)}</b><b>${reais(v.total)}</b></div>
          <div class="suave">${esc(v.vendedor_nome)} · ${v.pagamentos.map((p) => NOMES_METODO[p.metodo]).join(' + ')}${v.desconto ? ' · desc. ' + reais(v.desconto) : ''}</div>
          <div class="suave">${v.itens.map((i) => `${i.quantidade}× ${esc(i.produto_nome)}`).join(', ')}</div>
          ${v.cancelada ? '<span class="selo erro">cancelada</span>' : `<button class="btn peq perigo" style="margin-top:4px" onclick="App.cancelarVenda(${v.id})">Cancelar venda</button>`}</li>`).join('') || '<li class="vazio">Nenhuma venda.</li>'}</ul></div>
      <div class="cartao"><h3 style="margin-top:0">Despesas</h3><ul class="lista">
        ${despesas.map((d) => `<li class="entre"><span>${esc(d.descricao)}<div class="suave">${dataBR(d.data)} · ${esc(d.pago_por_nome)}</div></span><b>${reais(d.valor)}</b></li>`).join('') || '<li class="vazio">Nenhuma despesa.</li>'}</ul></div>`;
  }
  async function cancelarVenda(id) {
    if (!confirm(`Cancelar a venda #${id}? Os produtos voltam para o estoque.`)) return;
    await tentar(async () => { await api('POST', `/api/vendas/${id}/cancelar`, { pessoa_id: S.usuario.id }); aviso('Venda cancelada'); telaRelatorios(); });
  }

  // ---------- CAIXA ----------
  const CEDULAS = [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 10, 5];
  const difTexto = (d) => (d === 0 ? '<b class="pos">✔ Bateu</b>' : d > 0 ? `<b class="pos">Sobrou ${reais(d)}</b>` : `<b class="neg">Faltou ${reais(-d)}</b>`);

  async function telaCaixa() {
    const [cx, historico] = await Promise.all([api('GET', '/api/caixa'), api('GET', '/api/caixas')]);
    S.caixa = cx;
    const fechados = historico.filter((c) => !c.aberto);
    const hist = `<h3>Fechamentos anteriores</h3><div class="cartao"><ul class="lista">${fechados.map((c) => `<li class="entre" onclick="App.verFechamento(${c.id})" style="cursor:pointer">
      <span><b>${dataBR(c.aberto_em)}</b> → ${c.fechado_em.slice(11, 16)}<div class="suave">${esc(c.fechado_por_nome)} · ${c.vendas} venda(s) · ${reais(c.total_vendas)}</div></span>
      <span>${difTexto(c.diferenca)}</span></li>`).join('') || '<li class="vazio">Nenhum fechamento ainda.</li>'}</ul></div>`;

    if (!cx) {
      $('#tela').innerHTML = `<h2>💰 Caixa</h2>
        <div class="cartao"><p><b>O caixa está fechado.</b></p><p class="suave">Conte o dinheiro de troco que está na gaveta para abrir.</p>
          <label>Fundo de troco (R$)<input id="cx-fundo" inputmode="decimal" placeholder="0,00"></label>
          <button class="btn largo" onclick="App.abrirCaixa()">Abrir caixa</button></div>${hist}`;
      return;
    }
    const pm = cx.por_metodo;
    $('#tela').innerHTML = `<h2>💰 Caixa aberto</h2>
      <p class="suave">Aberto por ${esc(cx.aberto_por_nome)} em ${dataBR(cx.aberto_em)}</p>
      <div class="kpis">
        <div class="kpi"><div class="suave">Vendas</div><div class="v">${reais(cx.total_vendas)}</div><div class="suave">${cx.vendas} venda(s)${cx.canceladas ? ` · ${cx.canceladas} cancelada(s)` : ''}</div></div>
        <div class="kpi destaque"><div class="suave">Dinheiro na gaveta</div><div class="v">${reais(cx.dinheiro_esperado)}</div><div class="suave">esperado</div></div>
      </div>
      <div class="cartao"><h3 style="margin-top:0">Dinheiro</h3><ul class="lista">
        <li class="entre"><span>Fundo de troco</span><b>${reais(cx.fundo_inicial)}</b></li>
        <li class="entre"><span>Vendas em dinheiro</span><b>+ ${reais(pm.dinheiro)}</b></li>
        <li class="entre"><span>Reforços</span><b>+ ${reais(cx.reforcos)}</b></li>
        <li class="entre"><span>Sangrias</span><b>− ${reais(cx.sangrias)}</b></li>
        <li class="entre"><b>Esperado na gaveta</b><b>${reais(cx.dinheiro_esperado)}</b></li></ul>
        <div class="linha" style="margin-top:8px"><button class="btn sec" onclick="App.dialogoMovimento('sangria')">− Sangria (retirada)</button>
          <button class="btn sec" onclick="App.dialogoMovimento('reforco')">+ Reforço de troco</button></div>
        ${cx.movimentos.length ? `<ul class="lista" style="margin-top:8px">${cx.movimentos.map((m) => `<li class="entre suave"><span>${m.data.slice(11, 16)} · ${m.tipo === 'sangria' ? 'Sangria' : 'Reforço'} · ${esc(m.pessoa_nome)}${m.motivo ? ' · ' + esc(m.motivo) : ''}</span><span>${m.tipo === 'sangria' ? '−' : '+'} ${reais(m.valor)}</span></li>`).join('')}</ul>` : ''}</div>
      <div class="cartao"><h3 style="margin-top:0">Outras formas</h3><ul class="lista">
        ${['pix', 'debito', 'credito'].map((m) => `<li class="entre"><span>${NOMES_METODO[m]}</span><b>${reais(pm[m])}</b></li>`).join('')}</ul></div>

      <div class="cartao" style="border-color:var(--azul)"><h3 style="margin-top:0">Fechar caixa</h3>
        <details><summary class="suave" style="cursor:pointer;margin-bottom:8px">🧮 Contar cédulas e moedas</summary>
          <div class="grade-cedulas">${CEDULAS.map((c) => `<label>${reais(c)}<input type="number" min="0" inputmode="numeric" data-cedula="${c}" oninput="App.somarCedulas()"></label>`).join('')}</div>
        </details>
        <label>Dinheiro contado na gaveta (R$)<input id="fc-dinheiro" inputmode="decimal" placeholder="0,00" oninput="App.previaFechamento()"></label>
        <div id="fc-dif-dinheiro" style="margin-bottom:10px"></div>
        <p class="suave" style="margin:0 0 6px">Conferência com maquininha/extrato (opcional):</p>
        <div class="linha">${['pix', 'debito', 'credito'].map((m) => `<label>${NOMES_METODO[m]} (sistema ${reais(pm[m])})
          <input id="fc-${m}" inputmode="decimal" placeholder="0,00" oninput="App.previaFechamento()"><span id="fc-dif-${m}" class="suave"></span></label>`).join('')}</div>
        <label>Observação<input id="fc-obs" placeholder="Ex.: faltou troco de R$ 0,50"></label>
        <button class="btn largo" onclick="App.fecharCaixa()">Fechar caixa</button></div>${hist}`;
  }
  async function abrirCaixa() {
    const fundo = centavos($('#cx-fundo').value) ?? 0;
    await tentar(async () => {
      await api('POST', '/api/caixa/abrir', { pessoa_id: S.usuario.id, fundo_inicial: fundo });
      aviso('Caixa aberto ✔'); ir('vender');
    });
  }
  function dialogoMovimento(tipo) {
    abrirDialogo(`<h2>${tipo === 'sangria' ? 'Sangria (retirar dinheiro)' : 'Reforço de troco'}</h2>
      ${tipo === 'sangria' ? `<p class="suave">Dinheiro na gaveta: ${reais(S.caixa.dinheiro_esperado)}</p>` : ''}
      <label>Valor (R$)<input id="mv-valor" inputmode="decimal" placeholder="0,00"></label>
      <label>Motivo<input id="mv-motivo" placeholder="${tipo === 'sangria' ? 'Ex.: depósito no banco' : 'Ex.: troco extra'}"></label>
      <div class="linha"><button class="btn sec" onclick="App.fecharDialogo()">Cancelar</button>
      <button class="btn" onclick="App.salvarMovimento('${tipo}')">Confirmar</button></div>`);
  }
  async function salvarMovimento(tipo) {
    const valor = centavos($('#mv-valor').value);
    if (!valor) return aviso('Informe o valor', true);
    await tentar(async () => {
      await api('POST', '/api/caixa/movimento', { pessoa_id: S.usuario.id, tipo, valor, motivo: $('#mv-motivo').value });
      fecharDialogo(); aviso(tipo === 'sangria' ? 'Sangria registrada' : 'Reforço registrado'); telaCaixa();
    });
  }
  function somarCedulas() {
    const total = [...document.querySelectorAll('[data-cedula]')].reduce((s, el) => s + (Number(el.value) || 0) * Number(el.dataset.cedula), 0);
    $('#fc-dinheiro').value = paraCampo(total);
    previaFechamento();
  }
  function previaFechamento() {
    const cx = S.caixa;
    const din = centavos($('#fc-dinheiro').value);
    $('#fc-dif-dinheiro').innerHTML = din == null ? '' : `Esperado ${reais(cx.dinheiro_esperado)} · ${difTexto(din - cx.dinheiro_esperado)}`;
    for (const m of ['pix', 'debito', 'credito']) {
      const v = centavos($('#fc-' + m).value);
      $('#fc-dif-' + m).innerHTML = v == null ? '' : difTexto(v - cx.por_metodo[m]);
    }
  }
  async function fecharCaixa() {
    const din = centavos($('#fc-dinheiro').value);
    if (din == null) return aviso('Informe o dinheiro contado', true);
    const dif = din - S.caixa.dinheiro_esperado;
    const msg = dif === 0 ? 'O dinheiro bateu.' : dif > 0 ? `Sobrou ${reais(dif)}.` : `Faltou ${reais(-dif)}.`;
    if (!confirm(`${msg}\nConfirmar o fechamento do caixa? Depois de fechado, as vendas dele não podem ser canceladas.`)) return;
    const conferidos = {};
    for (const m of ['pix', 'debito', 'credito']) { const v = centavos($('#fc-' + m).value); if (v != null) conferidos[m] = v; }
    await tentar(async () => {
      const f = await api('POST', '/api/caixa/fechar', { pessoa_id: S.usuario.id, dinheiro_contado: din, conferidos, observacao: $('#fc-obs').value });
      S.caixa = null; await telaCaixa(); mostrarFechamento(f);
    });
  }
  async function verFechamento(id) { await tentar(async () => mostrarFechamento(await api('GET', '/api/caixas/' + id))); }
  function mostrarFechamento(c) {
    const pm = c.por_metodo;
    abrirDialogo(`<h2>Fechamento de caixa #${c.id}</h2>
      <p class="suave">${dataBR(c.aberto_em)} até ${dataBR(c.fechado_em)}<br>Aberto por ${esc(c.aberto_por_nome)} · fechado por ${esc(c.fechado_por_nome)}</p>
      <ul class="lista">
        <li class="entre"><span>Vendas (${c.vendas})${c.canceladas ? ` <span class="suave">${c.canceladas} cancelada(s)</span>` : ''}</span><b>${reais(c.total_vendas)}</b></li>
        <li class="entre"><span>Fundo de troco</span><span>${reais(c.fundo_inicial)}</span></li>
        <li class="entre"><span>Vendas em dinheiro</span><span>+ ${reais(pm.dinheiro)}</span></li>
        <li class="entre"><span>Reforços / Sangrias</span><span>+ ${reais(c.reforcos)} / − ${reais(c.sangrias)}</span></li>
        <li class="entre"><span>Dinheiro esperado</span><b>${reais(c.dinheiro_esperado)}</b></li>
        <li class="entre"><span>Dinheiro contado</span><b>${reais(c.dinheiro_contado)}</b></li>
        <li class="entre"><span>Diferença</span>${difTexto(c.diferenca)}</li>
        ${['pix', 'debito', 'credito'].map((m) => `<li class="entre"><span>${NOMES_METODO[m]}</span><span>${reais(pm[m])}${c.conferidos?.[m] != null ? ' · conferido ' + reais(c.conferidos[m]) + ' ' + difTexto(c.diferencas[m]) : ''}</span></li>`).join('')}
      </ul>
      ${c.observacao ? `<p class="suave">Obs.: ${esc(c.observacao)}</p>` : ''}
      <button class="btn largo" onclick="App.fecharDialogo()">OK</button>`);
  }

  // ---------- MAIS (cadastros) ----------
  function telaMais() {
    $('#tela').innerHTML = `<h2>Cadastros e ajustes</h2><div class="menu-mais">
      <button onclick="App.telaCaixa()"><span>💰</span>Caixa</button>
      <button onclick="App.telaProdutos()"><span>🍺</span>Produtos</button>
      <button onclick="App.telaPessoas()"><span>👥</span>Sócios e vendedores</button>
      <button onclick="App.telaTiposCusto()"><span>🚚</span>Custos extras</button>
      <button onclick="App.telaDespesas()"><span>💡</span>Despesas gerais</button>
      <button onclick="App.trocarUsuario()"><span>🔄</span>Trocar usuário</button></div>`;
  }
  const voltar = '<button class="btn sec peq" onclick="App.ir(\'mais\')">← Voltar</button>';

  async function telaProdutos() {
    S.produtos = await api('GET', '/api/produtos');
    $('#tela').innerHTML = `<div class="entre">${voltar}<button class="btn peq" onclick="App.dialogoProduto()">+ Novo produto</button></div>
      <h2 style="margin-top:12px">Produtos</h2><div class="cartao"><ul class="lista">${S.produtos.map((p) => `<li class="entre ${p.ativo ? '' : 'cancelada'}">
        <span><b>${esc(p.nome)}</b>${p.categoria ? `<span class="selo">${esc(p.categoria)}</span>` : ''}<div class="suave">${reais(p.preco_venda)} · mín. ${p.estoque_minimo} · estoque ${p.estoque}</div></span>
        <button class="btn peq sec" style="flex:0" onclick="App.dialogoProduto(${p.id})">Editar</button></li>`).join('') || '<li class="vazio">Nenhum produto.</li>'}</ul></div>`;
  }
  function dialogoProduto(id) {
    const p = id ? produto(id) : { nome: '', categoria: '', preco_venda: null, estoque_minimo: 0, ativo: 1 };
    const cats = [...new Set(S.produtos.map((x) => x.categoria).filter(Boolean))];
    abrirDialogo(`<h2>${id ? 'Editar' : 'Novo'} produto</h2>
      <label>Nome<input id="pr-nome" value="${esc(p.nome)}"></label>
      <label>Categoria<input id="pr-cat" list="cats" value="${esc(p.categoria)}" placeholder="Ex.: Cerveja, Refrigerante, Gelo"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <div class="linha"><label>Preço de venda (R$)<input id="pr-preco" inputmode="decimal" value="${paraCampo(p.preco_venda)}"></label>
      <label>Estoque mínimo<input id="pr-min" type="number" min="0" value="${p.estoque_minimo}"></label></div>
      ${id ? `<label><input type="checkbox" id="pr-ativo" style="width:auto" ${p.ativo ? 'checked' : ''}> Ativo (aparece nas vendas)</label>` : ''}
      <div class="linha"><button class="btn sec" onclick="App.fecharDialogo()">Cancelar</button><button class="btn" onclick="App.salvarProduto(${id || 0})">Salvar</button></div>`);
  }
  async function salvarProduto(id) {
    const preco = centavos($('#pr-preco').value);
    if (preco == null) return aviso('Informe o preço de venda', true);
    const dados = { nome: $('#pr-nome').value, categoria: $('#pr-cat').value, preco_venda: preco,
      estoque_minimo: Number($('#pr-min').value) || 0, ativo: id ? $('#pr-ativo').checked : true };
    await tentar(async () => { await api(id ? 'PUT' : 'POST', '/api/produtos' + (id ? '/' + id : ''), dados); fecharDialogo(); aviso('Produto salvo'); telaProdutos(); });
  }

  async function telaPessoas() {
    S.pessoas = await api('GET', '/api/pessoas');
    $('#tela').innerHTML = `<div class="entre">${voltar}<button class="btn peq" onclick="App.dialogoPessoa()">+ Nova pessoa</button></div>
      <h2 style="margin-top:12px">Sócios e vendedores</h2><div class="cartao"><ul class="lista">${S.pessoas.map((p) => `<li class="entre ${p.ativo ? '' : 'cancelada'}">
        <span><b>${esc(p.nome)}</b>${p.socio ? '<span class="selo">sócio</span>' : ''}${p.vendedor ? '<span class="selo">vendedor</span>' : ''}</span>
        <button class="btn peq sec" style="flex:0" onclick="App.dialogoPessoa(${p.id})">Editar</button></li>`).join('')}</ul></div>`;
  }
  function dialogoPessoa(id) {
    const p = id ? S.pessoas.find((x) => x.id === id) : { nome: '', socio: 0, vendedor: 1, ativo: 1 };
    abrirDialogo(`<h2>${id ? 'Editar' : 'Nova'} pessoa</h2>
      <label>Nome<input id="pe-nome" value="${esc(p.nome)}"></label>
      <label><input type="checkbox" id="pe-socio" style="width:auto" ${p.socio ? 'checked' : ''}> Sócio (paga compras e despesas)</label>
      <label><input type="checkbox" id="pe-vend" style="width:auto" ${p.vendedor ? 'checked' : ''}> Vendedor (registra vendas)</label>
      ${id ? `<label><input type="checkbox" id="pe-ativo" style="width:auto" ${p.ativo ? 'checked' : ''}> Ativo</label>` : ''}
      <div class="linha"><button class="btn sec" onclick="App.fecharDialogo()">Cancelar</button><button class="btn" onclick="App.salvarPessoa(${id || 0})">Salvar</button></div>`);
  }
  async function salvarPessoa(id) {
    const dados = { nome: $('#pe-nome').value, socio: $('#pe-socio').checked, vendedor: $('#pe-vend').checked, ativo: id ? $('#pe-ativo').checked : true };
    await tentar(async () => {
      await api(id ? 'PUT' : 'POST', '/api/pessoas' + (id ? '/' + id : ''), dados);
      fecharDialogo(); aviso('Salvo'); await carregarBase(); telaPessoas();
    });
  }

  async function telaTiposCusto() {
    S.tiposCusto = await api('GET', '/api/tipos-custo');
    $('#tela').innerHTML = `${voltar}<h2 style="margin-top:12px">Custos extras cadastrados</h2>
      <p class="suave">Aparecem como atalho na tela de Entrada. O valor é dividido entre os produtos da compra, proporcional ao valor de cada um.</p>
      <div class="cartao"><div class="linha"><label>Nome<input id="tc-nome" placeholder="Ex.: Frete, Gelo, Sacolas"></label>
        <label>Valor padrão (R$, opcional)<input id="tc-valor" inputmode="decimal" placeholder="0,00"></label>
        <button class="btn" style="flex:0 0 auto;align-self:end;margin-bottom:8px" onclick="App.salvarTipoCusto()">Adicionar</button></div>
      <ul class="lista">${S.tiposCusto.map((t) => `<li class="entre"><span>${esc(t.nome)} <span class="suave">${t.valor_padrao ? reais(t.valor_padrao) : ''}</span></span>
        <button class="btn peq perigo" style="flex:0" onclick="App.excluirTipoCusto(${t.id})">Excluir</button></li>`).join('') || '<li class="vazio">Nenhum custo cadastrado.</li>'}</ul></div>`;
  }
  async function salvarTipoCusto() {
    await tentar(async () => { await api('POST', '/api/tipos-custo', { nome: $('#tc-nome').value, valor_padrao: centavos($('#tc-valor').value) || 0 }); telaTiposCusto(); });
  }
  async function excluirTipoCusto(id) { await tentar(async () => { await api('DELETE', '/api/tipos-custo/' + id); telaTiposCusto(); }); }

  async function telaDespesas() {
    const lista = await api('GET', '/api/despesas');
    $('#tela').innerHTML = `${voltar}<h2 style="margin-top:12px">Despesas gerais</h2>
      <p class="suave">Gastos que não são de um produto específico (energia do freezer, aluguel, manutenção). Entram no lucro final e no acerto dos sócios.</p>
      <div class="cartao">
        <div class="linha"><label>Descrição<input id="d-desc"></label><label>Valor (R$)<input id="d-valor" inputmode="decimal" placeholder="0,00"></label></div>
        <div class="linha"><label>Data<input id="d-data" type="date" value="${dataLocal()}"></label>
          <label>Quem pagou<select id="d-pago">${socios().map((s) => `<option value="${s.id}" ${S.usuario.id === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select></label>
          <label>Forma<select id="d-metodo">${S.constantes.METODOS_COMPRA.map((m) => `<option value="${m}">${NOMES_METODO[m]}</option>`).join('')}</select></label></div>
        <button class="btn largo" onclick="App.salvarDespesa()">Registrar despesa</button></div>
      <div class="cartao"><ul class="lista">${lista.map((d) => `<li class="entre"><span>${esc(d.descricao)}<div class="suave">${dataBR(d.data)} · ${esc(d.pago_por_nome)} · ${NOMES_METODO[d.metodo_pagamento]}</div></span><b>${reais(d.valor)}</b></li>`).join('') || '<li class="vazio">Nenhuma despesa.</li>'}</ul></div>`;
  }
  async function salvarDespesa() {
    await tentar(async () => {
      await api('POST', '/api/despesas', { descricao: $('#d-desc').value, valor: centavos($('#d-valor').value), data: $('#d-data').value,
        pago_por: Number($('#d-pago').value), metodo_pagamento: $('#d-metodo').value });
      aviso('Despesa registrada'); telaDespesas();
    });
  }

  // ---------- diálogo ----------
  function abrirDialogo(html) { const d = $('#dialogo'); d.innerHTML = html; d.showModal(); d.querySelector('input,select')?.focus(); }
  function fecharDialogo() { $('#dialogo').close(); }

  // ---------- início ----------
  async function iniciar() {
    try { await carregarBase(); } catch (e) { $('#tela').innerHTML = `<div class="cartao vazio">Não foi possível conectar ao servidor.<br>${esc(e.message)}</div>`; return; }
    ir('vender');
  }
  document.addEventListener('DOMContentLoaded', iniciar);

  return { ir, trocarUsuario, entrar, primeiroUso, buscar, addCarrinho, mudarQtd, escolherMetodo, addPagamento, setPagamento, rmPagamento,
    setDesconto, limparVenda, finalizarVenda, dialogoPerda, salvarPerda, setEntrada, setItem, addItemEntrada, rmItem, addExtra, setExtra, rmExtra,
    salvarEntrada, setPeriodo, setDatas, cancelarVenda, telaProdutos, dialogoProduto, salvarProduto, telaPessoas, dialogoPessoa, salvarPessoa,
    telaTiposCusto, salvarTipoCusto, excluirTipoCusto, telaDespesas, salvarDespesa, fecharDialogo,
    telaCaixa, abrirCaixa, dialogoMovimento, salvarMovimento, somarCedulas, previaFechamento, fecharCaixa, verFechamento };
})();
