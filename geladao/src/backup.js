// Backup do banco SQLite: uma cópia por dia (guarda as últimas N) e cópia sob demanda.
// Usa "VACUUM INTO", que gera um arquivo consistente mesmo com o sistema em uso.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PADRAO_NOME = /^geladao-(\d{4}-\d{2}-\d{2})\.db$/;

function dataLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function criarBackup(db, { pasta, manter = 30, agora = () => new Date() }) {
  fs.mkdirSync(pasta, { recursive: true });

  function listar() {
    return fs.readdirSync(pasta)
      .filter((n) => PADRAO_NOME.test(n))
      .map((n) => {
        const st = fs.statSync(path.join(pasta, n));
        return { nome: n, data: n.match(PADRAO_NOME)[1], bytes: st.size };
      })
      .sort((a, b) => b.data.localeCompare(a.data));
  }

  function copiarPara(destino) {
    const tmp = destino + '.tmp';
    fs.rmSync(tmp, { force: true });
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, destino); // troca atômica: nunca fica um backup pela metade
    return destino;
  }

  // Faz o backup do dia se ainda não existe e apaga os mais antigos
  function backupDiario() {
    const nome = `geladao-${dataLocal(agora())}.db`;
    const destino = path.join(pasta, nome);
    let criado = false;
    if (!fs.existsSync(destino)) { copiarPara(destino); criado = true; }
    for (const b of listar().slice(manter)) fs.rmSync(path.join(pasta, b.nome), { force: true });
    return { nome, criado };
  }

  // Cópia atual em arquivo temporário, para download
  function copiaAgora() {
    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'geladao-')), 'copia.db');
    copiarPara(destino);
    const conteudo = fs.readFileSync(destino);
    fs.rmSync(path.dirname(destino), { recursive: true, force: true });
    return conteudo;
  }

  function lerArquivo(nome) {
    if (!PADRAO_NOME.test(nome)) return null; // evita acesso a outros arquivos
    const arq = path.join(pasta, nome);
    return fs.existsSync(arq) ? fs.readFileSync(arq) : null;
  }

  // Confere de hora em hora se já fez o backup do dia
  function agendar() {
    const rodar = () => {
      try {
        const r = backupDiario();
        if (r.criado) console.log(`💾 Backup diário criado: ${r.nome}`);
      } catch (e) { console.error('Falha no backup diário:', e.message); }
    };
    rodar();
    const t = setInterval(rodar, 60 * 60 * 1000);
    t.unref();
    return t;
  }

  return { listar, backupDiario, copiaAgora, lerArquivo, agendar, pasta };
}

module.exports = { criarBackup, dataLocal };
