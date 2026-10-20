/**
 * Genere docs/Chapitre4_UniPortal.docx a partir de docs/Chapitre4_UniPortal.md.
 *
 * Le Markdown reste la source unique : ce script en convertit le sous-ensemble
 * utilise (titres, paragraphes, listes, tableaux, blocs de code, citations,
 * images et legendes) en document Word mis en forme.
 *
 * Usage : node docs/outils/build-docx.cjs   (necessite le paquet npm "docx")
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, ImageRun, Header, Footer, PageNumber, LevelFormat,
  TableLayoutType, PageBreak,
} = require('docx');

const DOCS = path.resolve(__dirname, '..');
const SOURCE = path.join(DOCS, 'Chapitre4_UniPortal.md');
const TARGET = path.join(DOCS, 'Chapitre4_UniPortal.docx');

/* Charte : identique a celle de l'application. */
const C = {
  navy: '1E1B4B', indigo: '312E81', accent: 'F59E0B', accentSoft: 'FEF3C7',
  text: '1F1D3A', muted: '6B6A85', field: 'F5F5F7', border: 'D5D3E8', tint: 'EEF0FF',
};
const FONT = 'Calibri';
const MONO = 'Consolas';
const PAGE_W = 11906;          // A4 en DXA
const MARGIN = 1418;           // 2,5 cm
const CONTENT_W = PAGE_W - 2 * MARGIN;
const CONTENT_PX = Math.round((CONTENT_W / 1440) * 96);

/* ------------------------------------------------------------------ */
/* Texte en ligne : **gras**, *italique*, `code`                        */
/* ------------------------------------------------------------------ */
function inlineRuns(text, base = {}) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const tok = m[0];
    if (tok.startsWith('**')) runs.push(...inlineRuns(tok.slice(2, -2), { ...base, bold: true }));
    else if (tok.startsWith('`')) {
      runs.push(new TextRun({
        text: tok.slice(1, -1), ...base, font: MONO, size: Math.round((base.size || 21) * 0.9),
        color: base.color || C.indigo, shading: { type: ShadingType.CLEAR, color: 'auto', fill: base.codeFill || C.tint },
      }));
    } else runs.push(...inlineRuns(tok.slice(1, -1), { ...base, italics: true }));
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...base }));
  return runs;
}

/* ------------------------------------------------------------------ */
/* Blocs                                                               */
/* ------------------------------------------------------------------ */
function heading(text, level) {
  const map = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
  return new Paragraph({ heading: map[level], children: inlineRuns(text), keepNext: true });
}

function paragraph(text) {
  // Un paragraphe qui annonce la suite (":" final ou intertitre en gras) reste avec elle.
  const keepNext = /:\s*$/.test(text) || /^\*\*[^*]+\*\*$/.test(text.trim());
  return new Paragraph({ children: inlineRuns(text), spacing: { after: 140, line: 300 }, alignment: AlignmentType.JUSTIFIED, keepNext });
}

let listInstance = 0;
function listItems(items, ordered) {
  listInstance += 1;
  return items.map((t) => new Paragraph({
    children: inlineRuns(t),
    numbering: { reference: ordered ? 'numbers' : 'bullets', level: 0, instance: listInstance },
    spacing: { after: 80, line: 290 },
  }));
}

function codeBlock(lines) {
  return lines.map((line, i) => new Paragraph({
    children: [new TextRun({ text: line.length ? line : ' ', font: MONO, size: 17, color: C.navy })],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: C.field },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.accent, space: 8 } },
    spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 180 : 0, line: 250 },
    indent: { left: 160, right: 160 },
    keepLines: true,
    keepNext: i < lines.length - 1,
  }));
}

function callout(text) {
  return new Paragraph({
    children: inlineRuns(text, { codeFill: 'FFFFFF' }),
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: C.accentSoft },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: C.accent, space: 10 } },
    spacing: { before: 160, after: 200, line: 290 },
    indent: { left: 200, right: 200 },
  });
}

function caption(text) {
  return new Paragraph({
    children: inlineRuns(text, { italics: true, size: 18, color: C.muted }),
    alignment: AlignmentType.CENTER,
    spacing: { before: 80, after: 240 },
  });
}

function tableCaption(text) {
  return new Paragraph({
    children: inlineRuns(text, { bold: true, size: 19, color: C.indigo }),
    spacing: { before: 200, after: 80 },
    keepNext: true,
  });
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { buf, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function image(rel) {
  const { buf, width, height } = pngSize(path.join(DOCS, rel));
  const maxH = 620;
  let w = CONTENT_PX;
  let h = Math.round((height / width) * w);
  if (h > maxH) { h = maxH; w = Math.round((width / height) * h); }
  return new Paragraph({
    children: [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 40 },
    keepNext: true,
  });
}

function table(rows) {
  const cells = rows.map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const header = cells[0];
  const body = cells.slice(2);
  const n = header.length;

  // Largeurs proportionnelles a la longueur du contenu, bornees.
  const weight = header.map((_, i) => {
    const lens = [header[i], ...body.map((r) => r[i] || '')].map((s) => s.replace(/[`*]/g, '').length);
    return Math.min(Math.max(Math.max(...lens), 8), 60);
  });
  const total = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map((w) => Math.floor((w / total) * CONTENT_W));

  // Largeur minimale : le plus long mot (ou fragment de code) doit tenir sur une ligne.
  const minW = header.map((_, i) => {
    const words = [header[i], ...body.map((r) => r[i] || '')].join(' ').replace(/[*]/g, '').split(/\s+/);
    const longest = Math.max(...words.map((w) => w.replace(/`/g, '').length));
    return Math.min(longest * 100 + 260, 3400);
  });
  for (let pass = 0; pass < 3; pass += 1) {
    const deficit = widths.reduce((d, w, i) => d + Math.max(0, minW[i] - w), 0);
    if (!deficit) break;
    const spare = widths.reduce((s, w, i) => s + Math.max(0, w - minW[i]), 0);
    widths.forEach((w, i) => {
      widths[i] = w < minW[i] ? minW[i] : Math.floor(w - ((w - minW[i]) / spare) * deficit);
    });
  }
  widths[n - 1] += CONTENT_W - widths.reduce((a, b) => a + b, 0);

  const border = { style: BorderStyle.SINGLE, size: 4, color: C.border };
  const borders = { top: border, bottom: border, left: border, right: border };
  const margins = { top: 70, bottom: 70, left: 100, right: 100 };

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: header.map((h, i) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: C.navy },
      borders, margins,
      children: [new Paragraph({ children: inlineRuns(h, { bold: true, color: 'FFFFFF', size: 18, codeFill: C.indigo }) })],
    })),
  });

  const bodyRows = body.map((r, ri) => new TableRow({
    cantSplit: true,
    children: header.map((_, i) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: ri % 2 ? C.field : 'FFFFFF' },
      borders, margins,
      children: [new Paragraph({ children: inlineRuns(r[i] || '', { size: 18 }) })],
    })),
  }));

  return [
    new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows: [headerRow, ...bodyRows] }),
    new Paragraph({ children: [], spacing: { after: 160 } }),
  ];
}

/* ------------------------------------------------------------------ */
/* Analyse du Markdown                                                 */
/* ------------------------------------------------------------------ */
function convert(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let firstH2 = true;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (line.startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i += 1;
      out.push(...codeBlock(code));
      continue;
    }

    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) {
      const level = h[1].length;
      // Annexes : chacune commence sur une nouvelle page.
      if (level === 2 && h[2].startsWith('Annexe A')) out.push(new Paragraph({ children: [new PageBreak()] }));
      if (level === 2 && firstH2) firstH2 = false;
      out.push(heading(h[2], level));
      i += 1;
      continue;
    }

    const img = line.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
    if (img) { out.push(image(img[1])); i += 1; continue; }

    if (/^\*(Figure|Tableau) /.test(line)) {
      const text = line.replace(/^\*|\*$/g, '');
      out.push(text.startsWith('Figure') ? caption(text) : tableCaption(text));
      i += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(...table(rows));
      continue;
    }

    if (line.startsWith('> ')) {
      const parts = [];
      while (i < lines.length && lines[i].startsWith('> ')) parts.push(lines[i++].slice(2));
      out.push(callout(parts.join(' ')));
      continue;
    }

    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
      out.push(...listItems(items, false));
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ''));
      out.push(...listItems(items, true));
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|\||> |- |\d+\. |!\[)/.test(lines[i])) para.push(lines[i++]);
    out.push(paragraph(para.join(' ')));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */
const md = fs.readFileSync(SOURCE, 'utf8');

const doc = new Document({
  creator: 'UniPortal',
  title: 'Chapitre 4 - Mise en œuvre : UniPortal',
  description: 'Documentation du projet UniPortal pour l\'exposé d\'administration réseau',
  styles: {
    default: { document: { run: { font: FONT, size: 21, color: C.text } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 40, bold: true, color: C.navy },
        paragraph: { spacing: { before: 0, after: 320 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.accent, space: 8 } } } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 30, bold: true, color: C.navy },
        paragraph: { spacing: { before: 420, after: 160 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 24, bold: true, color: C.indigo },
        paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 540, hanging: 270 } }, run: { color: C.accent } } }] },
      { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 540, hanging: 320 } }, run: { bold: true, color: C.indigo } } }] },
    ],
  },
  sections: [{
    properties: {
      page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } },
    },
    headers: {
      default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: 'Exposé d\'administration réseau - Chapitre 4 : mise en œuvre', size: 16, color: C.muted })],
      })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: C.muted })],
      })] }),
    },
    children: convert(md),
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(TARGET, buf);
  console.log('ecrit', path.relative(process.cwd(), TARGET));
});
