// Gerador mínimo de planilhas Excel (.xlsx) sem dependências.
// Um .xlsx é um ZIP com arquivos XML; aqui montamos o ZIP com o zlib nativo.

const zlib = require('node:zlib');

// Estilos (índices em cellXfs)
const E = { normal: 0, cabecalho: 1, moeda: 2, int: 3, data: 4, pct: 5, totalMoeda: 6, totalInt: 7, totalTexto: 8, titulo: 9 };
const ESTILO_TIPO = { texto: E.normal, int: E.int, moeda: E.moeda, data: E.data, pct: E.pct };
const ESTILO_TOTAL = { texto: E.totalTexto, int: E.totalInt, moeda: E.totalMoeda, data: E.totalTexto, pct: E.totalTexto };

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // remove caracteres de controle inválidos em XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function letraColuna(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 'AAAA-MM-DD' -> número de série do Excel
function serialData(txt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(txt || '');
  if (!m) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
}

function celula(ref, valor, tipo, estilo) {
  if (valor == null || valor === '') return estilo ? `<c r="${ref}" s="${estilo}"/>` : '';
  if (tipo === 'data') {
    const n = serialData(valor);
    if (n == null) return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t>${xmlEsc(valor)}</t></is></c>`;
    return `<c r="${ref}" s="${estilo}"><v>${n}</v></c>`;
  }
  if (tipo === 'texto' || typeof valor !== 'number') {
    return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(valor)}</t></is></c>`;
  }
  return `<c r="${ref}" s="${estilo}"><v>${Number.isFinite(valor) ? valor : 0}</v></c>`;
}

// aba = { nome, titulo?, colunas: [{titulo, campo, tipo, largura}], linhas: [obj], total?: obj }
function xmlAba(aba) {
  const cols = aba.colunas;
  const linhas = [];
  let r = 1;
  if (aba.titulo) {
    linhas.push(`<row r="${r}">${celula('A' + r, aba.titulo, 'texto', E.titulo)}</row>`);
    r += 2;
  }
  const linhaCab = r;
  linhas.push(`<row r="${r}">${cols.map((c, i) => celula(letraColuna(i) + r, c.titulo, 'texto', E.cabecalho)).join('')}</row>`);
  for (const obj of aba.linhas) {
    r++;
    linhas.push(`<row r="${r}">${cols.map((c, i) => celula(letraColuna(i) + r, obj[c.campo], c.tipo, ESTILO_TIPO[c.tipo] ?? 0)).join('')}</row>`);
  }
  const ultimaDados = r;
  if (aba.total) {
    r++;
    linhas.push(`<row r="${r}">${cols.map((c, i) => celula(letraColuna(i) + r, aba.total[c.campo], c.tipo, ESTILO_TOTAL[c.tipo])).join('')}</row>`);
  }
  const ultCol = letraColuna(cols.length - 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${linhaCab}" topLeftCell="A${linhaCab + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura || 14}" customWidth="1"/>`).join('')}</cols>
<sheetData>${linhas.join('')}</sheetData>
${aba.linhas.length ? `<autoFilter ref="A${linhaCab}:${ultCol}${ultimaDados}"/>` : ''}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
  <numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00;[Red]\\-&quot;R$&quot;\\ #,##0.00"/>
  <numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>
  <numFmt numFmtId="166" formatCode="0.0%"/>
</numFmts>
<fonts count="4">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF0B6FB8"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFE3F0FB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="center"/></xf>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
  <xf numFmtId="1" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
  <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function gerarXlsx(abas) {
  const nomeAba = (n) => xmlEsc(n.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const arquivos = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${abas.map((a, i) => `<sheet name="${nomeAba(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', ESTILOS],
    ...abas.map((a, i) => [`xl/worksheets/sheet${i + 1}.xml`, xmlAba(a)]),
  ];
  return zipar(arquivos.map(([nome, conteudo]) => [nome, Buffer.from(conteudo, 'utf8')]));
}

// ZIP simples (deflate) — formato PKWARE básico
function zipar(arquivos) {
  const partes = [];
  const central = [];
  let offset = 0;
  const agora = new Date();
  const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | Math.floor(agora.getSeconds() / 2);
  const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
  for (const [nome, dados] of arquivos) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const comprimido = zlib.deflateRawSync(dados);
    const crc = zlib.crc32(dados);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(hora, 10); local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comprimido.length, 18); local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26); local.writeUInt16LE(0, 28);
    partes.push(local, nomeBuf, comprimido);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(hora, 12); cd.writeUInt16LE(data, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comprimido.length, 20); cd.writeUInt32LE(dados.length, 24);
    cd.writeUInt16LE(nomeBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nomeBuf);
    offset += local.length + nomeBuf.length + comprimido.length;
  }
  const centralBuf = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(centralBuf.length, 12); fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, centralBuf, fim]);
}

module.exports = { gerarXlsx, serialData, letraColuna };
