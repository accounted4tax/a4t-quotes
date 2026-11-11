// loe-pdf — the signed PDF: engagement letter (Parts A–E as assembled for the quote), the acceptance record
// (tick boxes, typed signature, date/time, IP, device, quote version, document fingerprint), then the quote itself.
// deno-lint-ignore-file no-explicit-any
import * as PDFLib from 'npm:pdf-lib@1.17.1';

const { PDFDocument, StandardFonts, rgb } = PDFLib as any;
const NAVY = rgb(0x14 / 255, 0x21 / 255, 0x3d / 255), GOLD = rgb(0xb0 / 255, 0x8d / 255, 0x2a / 255);
const GREY = rgb(0x4a / 255, 0x55 / 255, 0x68 / 255), LINE = rgb(0xe3 / 255, 0xe6 / 255, 0xec / 255), LIGHT = rgb(0xf1 / 255, 0xf3 / 255, 0xf7 / 255);
const WHITE = rgb(1, 1, 1), BLACK = rgb(0.16, 0.2, 0.27), TEAL = rgb(0x0e / 255, 0x6e / 255, 0x6b / 255);
const MM = 72 / 25.4;

// Helvetica knows Windows-1252 only; replace anything else so pdf-lib never throws
const KEEP = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x20AC]);
const safe = (t: string) => Array.from(String(t ?? '')).map((ch) => {
  const c = ch.codePointAt(0)!;
  if (c >= 0x2010 && c <= 0x2012) return '-';
  if (c === 0x2192) return '->';
  return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || KEEP.has(c) ? ch : '';
}).join('');

type Run = { text: string; b?: boolean; i?: boolean };
// **bold**, *italic*, `code` (code marks dropped)
export function runs(s: string): Run[] {
  const out: Run[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], b: true });
    else if (m[2] !== undefined) out.push({ text: m[2], i: true });
    else out.push({ text: m[3] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

export type Block = { t: 'h2' | 'h3' | 'p' | 'li' | 'oli' | 'table'; text?: string; n?: number; rows?: string[][] };
export function parseMd(md: string): Block[] {
  const lines = md.split('\n'), out: Block[] = [];
  let para: string[] = [], n = 0;
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\s+$/, '');
    if (!l.trim()) { flush(); n = 0; continue; }
    if (l.startsWith('### ')) { flush(); out.push({ t: 'h3', text: l.slice(4) }); continue; }
    if (l.startsWith('## ')) { flush(); out.push({ t: 'h2', text: l.slice(3) }); continue; }
    if (l.startsWith('|')) {
      flush(); const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|[-| ]+\|$/.test(lines[i].trim())) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      i--; out.push({ t: 'table', rows }); continue;
    }
    const li = l.match(/^\s*-\s+(.*)$/); if (li) { flush(); out.push({ t: 'li', text: li[1] }); continue; }
    const oli = l.match(/^\s*\d+\.\s+(.*)$/); if (oli) { flush(); out.push({ t: 'oli', text: oli[1], n: ++n }); continue; }
    para.push(l);
  }
  flush();
  return out;
}

export async function buildSignedPdf(d: {
  loe: { parts: { key: string; title: string; md: string }[]; intro: string; items: { key: string; text: string; required: boolean }[] };
  ticks: Record<string, boolean>; signed_name: string; signed_at: Date; ip: string; user_agent: string;
  quote_number: string; quote_version: number; fingerprint: string; client_display: string; quotePdf: Uint8Array; practice: any;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Signed engagement letter and quote ${d.quote_number}`); doc.setAuthor('Accounted4Tax Ltd');
  const F = { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique), bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique) };
  const fontOf = (r: Run) => r.b && r.i ? F.bi : r.b ? F.b : r.i ? F.i : F.r;
  const W = 595.28, H = 841.89, L = 18 * MM, R = W - 18 * MM, CW = R - L;
  let page: any, y = 0, pageNo = 0;
  const p = d.practice || {};

  const newPage = () => {
    page = doc.addPage([W, H]); pageNo++;
    page.drawRectangle({ x: 0, y: H - 16 * MM, width: W, height: 16 * MM, color: NAVY });
    page.drawText('Accounted4Tax', { x: L, y: H - 10.5 * MM, size: 13, font: F.b, color: WHITE });
    const right = safe(`Engagement letter · Quote ${d.quote_number} v${d.quote_version} · ${d.client_display}`);
    page.drawText(right, { x: R - F.r.widthOfTextAtSize(right, 8), y: H - 10 * MM, size: 8, font: F.r, color: WHITE });
    const foot = safe(`${p.name || 'Accounted4Tax Ltd'} · Company number ${p.crn || '16438537'} · ${p.registered_office || '128 City Road, London EC1V 2NX'} · Signed online by ${d.signed_name} on ${fmt(d.signed_at)}`);
    page.drawText(foot, { x: L, y: 9 * MM, size: 6.5, font: F.r, color: GREY });
    const pn = `Page ${pageNo}`; page.drawText(pn, { x: R - F.r.widthOfTextAtSize(pn, 6.5), y: 9 * MM, size: 6.5, font: F.r, color: GREY });
    y = H - 26 * MM;
  };
  const need = (h: number) => { if (y - h < 18 * MM) newPage(); };

  // wrap mixed-font runs into lines of [run pieces]
  const layout = (rs: Run[], size: number, width: number) => {
    const lines: { text: string; font: any }[][] = [[]]; let w = 0;
    for (const r of rs) {
      const font = fontOf(r);
      const parts = safe(r.text).split(/(\s+|\n)/);
      for (const part of parts) {
        if (part === '') continue;
        if (part.includes('\n')) { lines.push([]); w = 0; continue; }
        const isSpace = /^\s+$/.test(part);
        const pw = font.widthOfTextAtSize(isSpace ? ' ' : part, size);
        if (!isSpace && w + pw > width && w > 0) { lines.push([]); w = 0; }
        if (isSpace && w === 0) continue;
        lines[lines.length - 1].push({ text: isSpace ? ' ' : part, font }); w += pw;
      }
    }
    return lines.filter((l, i) => l.length || i === 0);
  };
  const drawRuns = (rs: Run[], o: { size?: number; x?: number; width?: number; color?: any; gap?: number } = {}) => {
    const size = o.size ?? 9, x = o.x ?? L, width = o.width ?? (R - x), lh = size * 1.38;
    for (const ln of layout(rs, size, width)) {
      need(lh); let cx = x;
      for (const piece of ln) { page.drawText(piece.text, { x: cx, y: y - size, size, font: piece.font, color: o.color ?? BLACK }); cx += piece.font.widthOfTextAtSize(piece.text, size); }
      y -= lh;
    }
    y -= o.gap ?? 4;
  };

  const blocks = (md: string) => {
    for (const b of parseMd(md)) {
      if (b.t === 'h2') { need(30); y -= 6; drawRuns([{ text: b.text!, b: true }], { size: 12.5, color: NAVY, gap: 4 }); }
      else if (b.t === 'h3') { need(24); y -= 3; drawRuns([{ text: b.text!, b: true }], { size: 10.5, color: NAVY, gap: 3 }); }
      else if (b.t === 'p') drawRuns(runs(b.text!), { gap: 5 });
      else if (b.t === 'li' || b.t === 'oli') {
        const mark = b.t === 'li' ? '•' : `${b.n}.`;
        need(13); page.drawText(safe(mark), { x: L + 3, y: y - 9, size: 9, font: F.r, color: BLACK });
        drawRuns(runs(b.text!), { x: L + 16, gap: 3 });
      } else if (b.t === 'table' && b.rows?.length) {
        const [head, ...rows] = b.rows;
        for (const r of rows) {
          need(30);
          page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.4, color: LINE }); y -= 4;
          drawRuns(runs(`**${r[0]}**`), { gap: 2 });
          for (let c = 1; c < r.length; c++) drawRuns(runs(`*${head[c]}:* ${r[c]}`), { x: L + 10, gap: 2 });
          y -= 3;
        }
        y -= 3;
      }
    }
  };

  newPage();
  page.drawText('Engagement letter', { x: L, y: y - 16, size: 18, font: F.b, color: NAVY }); y -= 26;
  drawRuns([{ text: `For ${d.client_display} · Quote ${d.quote_number}, version ${d.quote_version}`, i: true }], { color: GREY, gap: 8 });
  d.loe.parts.forEach((part, idx) => {
    if (idx > 0) { need(60); y -= 8; page.drawRectangle({ x: L, y: y - 2, width: CW, height: 1.2, color: GOLD }); y -= 10; }
    if (idx > 0) drawRuns([{ text: part.title, b: true }], { size: 14, color: NAVY, gap: 6 });
    blocks(part.md);
  });

  // acceptance record
  newPage();
  page.drawText('Acceptance record', { x: L, y: y - 16, size: 18, font: F.b, color: NAVY }); y -= 28;
  drawRuns(runs(d.loe.intro), { gap: 8 });
  for (const it of d.loe.items) {
    need(16);
    const ticked = !!d.ticks[it.key];
    page.drawRectangle({ x: L, y: y - 10, width: 9, height: 9, borderColor: NAVY, borderWidth: 0.8, color: ticked ? TEAL : WHITE });
    if (ticked) page.drawText('x', { x: L + 2.1, y: y - 8.6, size: 8, font: F.b, color: WHITE });
    drawRuns(runs(it.text + (ticked ? '' : ' (not ticked)')), { x: L + 16, gap: 5 });
  }
  y -= 6; need(120);
  page.drawRectangle({ x: L, y: y - 100, width: CW, height: 100, color: LIGHT });
  const rowsKv: [string, string][] = [
    ['Signed by (typed name)', d.signed_name], ['Date and time', fmt(d.signed_at) + ' (UK time)'], ['IP address', d.ip || 'not available'],
    ['Device', (d.user_agent || 'not available').slice(0, 88)], ['Quote', `${d.quote_number}, version ${d.quote_version}`],
    ['Document fingerprint (SHA-256)', d.fingerprint],
  ];
  let yy = y - 14;
  for (const [k, v] of rowsKv) {
    page.drawText(safe(k + ':'), { x: L + 8, y: yy, size: 8.5, font: F.b, color: NAVY });
    page.drawText(safe(v), { x: L + 58 * MM, y: yy, size: k.startsWith('Document') ? 6.8 : 8.5, font: F.r, color: BLACK });
    yy -= 14;
  }
  y -= 112;
  need(40);
  page.drawText(safe(d.signed_name), { x: L, y: y - 22, size: 20, font: F.i, color: NAVY });
  page.drawLine({ start: { x: L, y: y - 27 }, end: { x: L + 90 * MM, y: y - 27 }, thickness: 0.6, color: GREY });
  page.drawText('Signature (typed online)', { x: L, y: y - 36, size: 7.5, font: F.r, color: GREY });
  y -= 48;
  drawRuns(runs('The quote that forms part of this agreement follows.'), { color: GREY, size: 8.5 });

  // the quote (attached)
  const qd = await PDFDocument.load(d.quotePdf);
  const pages = await doc.copyPages(qd, qd.getPageIndices());
  pages.forEach((pg: any) => doc.addPage(pg));
  return await doc.save();
}

function fmt(dt: Date) {
  return dt.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}
