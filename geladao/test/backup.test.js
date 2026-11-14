const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abrirBanco } = require('../src/db');
const { criarLogica } = require('../src/logica');
const { criarBackup } = require('../src/backup');
const { criarServidor } = require('../src/server');

const pastaTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gel-bkp-'));

test('backup diário: um por dia, mantém só os N mais recentes, cópia é um banco válido', () => {
  const dir = pastaTemp();
  const db = abrirBanco(path.join(dir, 'geladao.db'));
  criarLogica(db).salvarPessoa({ nome: 'Ana', socio: true, vendedor: true, pin: '1234' });
  let dia = new Date(2026, 0, 1, 12);
  const bk = criarBackup(db, { pasta: path.join(dir, 'backups'), manter: 3, agora: () => dia });

  assert.equal(bk.backupDiario().criado, true);
  assert.equal(bk.backupDiario().criado, false); // mesmo dia: não repete
  for (let i = 0; i < 4; i++) { dia = new Date(dia.getTime() + 86400000); bk.backupDiario(); }
  const lista = bk.listar();
  assert.deepEqual(lista.map((b) => b.data), ['2026-01-05', '2026-01-04', '2026-01-03']);

  const copia = new DatabaseSync(path.join(dir, 'backups', lista[0].nome));
  assert.equal(copia.prepare('SELECT nome FROM pessoas').get().nome, 'Ana');
  copia.close();
  assert.equal(bk.lerArquivo('../geladao.db'), null); // não deixa ler outros arquivos
  assert.equal(bk.copiaAgora().subarray(0, 15).toString(), 'SQLite format 3');
});

test('API de backup: só sócio lista e baixa', async (t) => {
  const dir = pastaTemp();
  const db = abrirBanco(path.join(dir, 'geladao.db'));
  const backup = criarBackup(db, { pasta: path.join(dir, 'backups') });
  backup.backupDiario();
  const srv = criarServidor(db, { backup });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => srv.close(ok)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (url, token, corpo) => fetch(base + url, {
    method: corpo ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

  assert.equal((await req('/api/saude')).status, 200);
  const socio = (await (await req('/api/primeiro-uso', null, { nome: 'Ana', pin: '1234' })).json()).token;
  await req('/api/pessoas', socio, { nome: 'Caio', vendedor: true, pin: '4321' });
  const vend = (await (await req('/api/login', null, { pessoa_id: 2, pin: '4321' })).json()).token;

  assert.equal((await req('/api/backups', vend)).status, 403);
  assert.equal((await req('/api/backups/agora', vend)).status, 403);
  const lista = await (await req('/api/backups', socio)).json();
  assert.equal(lista.ativo, true);
  assert.equal(lista.lista.length, 1);

  const agora = await req('/api/backups/agora', socio);
  assert.equal(agora.status, 200);
  assert.match(agora.headers.get('content-disposition'), /geladao-backup_.*\.db/);
  const buf = Buffer.from(await agora.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');

  const arq = await req('/api/backups/arquivo?nome=' + lista.lista[0].nome, socio);
  assert.equal(arq.status, 200);
  assert.equal((await req('/api/backups/arquivo?nome=../geladao.db', socio)).status, 404);
});
