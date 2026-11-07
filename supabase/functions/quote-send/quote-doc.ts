// quote-doc — turns a saved quote into the client view (sections, headings, totals) and the PDF.
// Same layout as the client page q.html and as the quote PDFs sent from the Letters app
// (navy letterhead, QUOTE, Prepared for box, numbered sections, teal total bars, Notes, Accept button).
// deno-lint-ignore-file no-explicit-any
import * as PDFLib from 'npm:pdf-lib@1.17.1';

const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = PDFLib as any;
const NAVY = rgb(0x14 / 255, 0x21 / 255, 0x3d / 255), TEAL = rgb(0x0e / 255, 0x6e / 255, 0x6b / 255);
const GREY = rgb(0x4a / 255, 0x55 / 255, 0x68 / 255), LIGHT = rgb(0xf1 / 255, 0xf3 / 255, 0xf7 / 255), LINE = rgb(0xe3 / 255, 0xe6 / 255, 0xec / 255);
const WHITE = rgb(1, 1, 1), BLACK = rgb(0.16, 0.2, 0.27);
const MM = 72 / 25.4;

const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const down = (v: number, n: number) => Math.floor(r2(v * 100 / n)) / 100;
export const gbp = (n: number) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fd = (d?: string | null) => !d ? '' : new Date(String(d).length === 10 ? d + 'T12:00:00Z' : String(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

// ---------- view model (mirrors q.html) ----------
export type Line = { description: string; about?: string | null; period_label?: string | null; quantity?: number | null; unit_label?: string | null; unit_price?: number | null;
  is_earlier_year?: boolean; pricing_type?: string; months?: number | null; price_period?: string | null; kind: string; gross: number; discount: number; total: number; deposit?: number | null; balance?: number | null };

// "Accounts for the year ended 31 May 2025" → "31 May 2025"
function periodDate(label?: string | null) {
  const m = String(label || '').match(/year (?:ended|ending)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
const andList = (a: string[]) => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

export function catchUpHeading(lines: Line[]) {
  const dates = [...new Set(lines.map((l) => periodDate(l.period_label)).filter(Boolean) as string[])];
  if (!dates.length) return { suffix: '', hideLabel: false };
  const allSame = dates.length === 1 && lines.every((l) => periodDate(l.period_label) === dates[0] || !l.period_label);
  return { suffix: dates.length === 1 ? ` – for the year ended ${dates[0]}` : ` – for the years ended ${andList(dates)}`, hideLabel: allSame };
}
export function yearEndHeading(clientType: string, yearEnd?: string | null) {
  if (!yearEnd) return '';
  if (clientType === 'ltd') return ` – for the year ending ${fd(yearEnd)}`;
  const y = Number(String(yearEnd).slice(0, 4));
  return ` – for the tax year ${y - 1}/${String(y).slice(-2)} (to ${fd(yearEnd)})`;
}

export function lineLabel(l: Line, hidePeriod = false) {
  let t = l.description + (l.is_earlier_year ? ' catch-up' : '');
  if (l.about) t += ` – ${l.about}`;
  const extra: string[] = [];
  if (l.period_label && !(hidePeriod && periodDate(l.period_label))) extra.push(l.period_label);
  if (l.pricing_type === 'income_based' && l.quantity != null) extra.push('based on estimated income of ' + gbp(Number(l.quantity)));
  else if (l.pricing_type && l.pricing_type !== 'fixed' && l.quantity != null) extra.push(`${Number(l.quantity)} ${l.unit_label || ''}`.trim());
  if (l.price_period === 'monthly' && l.kind !== 'ongoing' && l.months) extra.push(`${l.months} × ${gbp(Number(l.unit_price))}`);
  return t + (extra.length ? ` (${extra.join(', ')})` : '');
}

export function buildView(d: { quote: any; lines: Line[]; client: any }) {
  const q = d.quote, L = d.lines;
  const grp = (l: Line) => l.kind === 'deposit_balance' ? 'sa' : l.kind === 'one_off' ? 'catch_up' : (l.price_period === 'monthly' ? 'monthly' : 'year_end');
  const G: Record<string, Line[]> = { catch_up: [], sa: [], year_end: [], monthly: [] };
  L.forEach((l) => G[grp(l)].push(l));
  const sum = (a: Line[], f: (l: Line) => number) => r2(a.reduce((s, x) => s + Number(f(x) || 0), 0));
  const n = q.monthly_allowed ? Number(q.payments_count) : 0;
  const yeTotal = sum(G.year_end, (l) => l.total), msTotal = sum(G.monthly, (l) => l.total);
  return {
    G, n,
    catchTotal: sum(G.catch_up, (l) => l.total), yeTotal, msTotal,
    yePm: n ? down(yeTotal, n) : 0, msPm: n ? down(msTotal, n) : 0,
    saNow: sum(G.sa, (l) => Number(l.deposit)),
    catchHead: catchUpHeading(G.catch_up),
    yeHead: yearEndHeading(d.client.client_type, q.year_end_date),
    perMonth: (l: Line) => l.months ? r2(Number(l.total) / l.months) : Number(l.total),
  };
}

// ---------- PDF ----------
// Helvetica only knows Windows-1252; replace anything else so pdf-lib never throws
const KEEP = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x20AC]);
const safe = (t: string) => Array.from(String(t ?? '')).map((ch) => {
  const c = ch.codePointAt(0)!;
  if (c >= 0x2010 && c <= 0x2012) return '-';
  return c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || KEEP.has(c) ? ch : '';
}).join('');

export async function buildQuotePdf(d: { practice: any; quote: any; lines: Line[]; client: any; accept_url: string }): Promise<Uint8Array> {
  const q = d.quote, c = d.client, p = d.practice || {};
  const V = buildView(d);
  const doc = await PDFDocument.create();
  doc.setTitle(`Quote ${q.quote_number}`); doc.setAuthor(p.name || 'Accounted4Tax Ltd');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, L = 18 * MM, R = W - 18 * MM, CW = R - L;
  let page: any, y = 0;
  const phone = p.phone || '', email = p.email || 'info@accounted4tax.co.uk';

  const wrap = (text: string, f: any, size: number, width: number) => {
    const out: string[] = [];
    for (const para of safe(text).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/)) {
        const t = line ? line + ' ' + w : w;
        if (f.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t;
      }
      out.push(line);
    }
    return out;
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 30 * MM, width: W, height: 30 * MM, color: NAVY });
    page.drawText('Accounted4Tax', { x: L, y: H - 15 * MM, size: 20, font: bold, color: WHITE });
    page.drawText(safe(p.tagline || 'Accountants for sole traders, contractors and limited companies'), { x: L, y: H - 21.5 * MM, size: 9, font, color: WHITE });
    [p.name || 'Accounted4Tax Ltd', p.registered_office || '128 City Road, London EC1V 2NX', email + (phone ? ' · ' + phone : '')].forEach((t, i) =>
      page.drawText(safe(t), { x: R - font.widthOfTextAtSize(safe(t), 8.5), y: H - 11 * MM - i * 4.6 * MM, size: 8.5, font, color: WHITE }));
    const foot = safe(`${p.name || 'Accounted4Tax Ltd'} · Registered in England and Wales, company number ${p.crn || '16438537'} · Registered office ${p.registered_office || '128 City Road, London EC1V 2NX'} · Not VAT registered`);
    page.drawText(foot, { x: (W - font.widthOfTextAtSize(foot, 7)) / 2, y: 10 * MM, size: 7, font, color: GREY });
    y = H - 38 * MM;
  };
  const need = (h: number) => { if (y - h < 22 * MM) newPage(); };
  const text = (t: string, o: { size?: number; f?: any; color?: any; gap?: number } = {}) => {
    const size = o.size ?? 9.5, f = o.f ?? font;
    for (const ln of wrap(t, f, size, CW)) { need(size + 4); page.drawText(ln, { x: L, y: y - size, size, font: f, color: o.color ?? BLACK }); y -= size + (o.gap ?? 3.5); }
  };
  const heading = (t: string) => { need(34); y -= 8; text(t, { size: 11.5, f: bold, color: NAVY }); y -= 1; };
  const sub = (t: string) => { text(t, { size: 8.5, color: GREY, gap: 2 }); y -= 1; };
  const row = (label: string, value: string, opts: { hl?: boolean; note?: string; was?: string } = {}) => {
    const lw = CW - 48 * MM, lines = wrap(label, font, 9.5, lw - 8), notes = opts.note ? wrap(opts.note, font, 8, lw - 8) : [];
    const h = Math.max(1, lines.length) * 12.5 + notes.length * 10.5 + (opts.was ? 4 : 0) + 6;
    need(h);
    if (opts.hl) page.drawRectangle({ x: L, y: y - h, width: CW, height: h, color: LIGHT });
    const f = opts.hl ? bold : font;
    wrap(label, f, 9.5, lw - 8).forEach((ln, i) => page.drawText(ln, { x: L + 4, y: y - 12 - i * 12.5 + 2, size: 9.5, font: f, color: opts.hl ? NAVY : BLACK }));
    notes.forEach((ln, i) => page.drawText(ln, { x: L + 4, y: y - 12 - lines.length * 12.5 - i * 10.5 + 3, size: 8, font, color: GREY }));
    const v = safe(value);
    page.drawText(v, { x: R - 4 - f.widthOfTextAtSize(v, 9.5), y: y - 12 + 2, size: 9.5, font: f, color: opts.hl ? NAVY : BLACK });
    if (opts.was) { const w = safe('was ' + opts.was); page.drawText(w, { x: R - 4 - font.widthOfTextAtSize(w, 7.5), y: y - 22 + 2, size: 7.5, font, color: GREY }); }
    page.drawLine({ start: { x: L, y: y - h }, end: { x: R, y: y - h }, thickness: 0.4, color: LINE });
    y -= h;
  };
  const bar = (label: string, value: string, small?: string, color = TEAL) => {
    const h = small ? 32 : 26;
    need(h + 6); y -= 5;
    page.drawRectangle({ x: L, y: y - h, width: CW, height: h, color });
    page.drawText(safe(label), { x: L + 8, y: y - 16, size: 12, font: bold, color: WHITE });
    if (small) page.drawText(safe(small), { x: L + 8, y: y - 27, size: 7.5, font, color: WHITE });
    const v = safe(value);
    page.drawText(v, { x: R - 8 - bold.widthOfTextAtSize(v, 14), y: y - (h / 2) - 5, size: 14, font: bold, color: WHITE });
    y -= h + 2;
  };
  const was = (l: Line, per = false) => Number(l.gross) > Number(l.total) + 0.004 ? gbp(per && l.months ? r2(Number(l.gross) / l.months) : Number(l.gross)) : undefined;

  newPage();
  page.drawText('QUOTE', { x: L, y: y - 18, size: 20, font: bold, color: NAVY }); y -= 30;
  const left = ['Prepared for', ...(c.client_type === 'ltd'
    ? [c.contact ? c.contact + ', Director' : '', c.company_name || c.name, c.crn ? 'Company number ' + c.crn : '']
    : [c.contact, c.trading_name || ''])].filter(Boolean).map(safe);
  const right: [string, string][] = [['Date', fd(q.sent_at || q.created_at)], ['Quote reference', q.quote_number]];
  if (q.expires_at) right.push(['Valid until', fd(q.expires_at)]);
  const boxH = Math.max(left.length, right.length) * 13 + 14;
  page.drawRectangle({ x: L, y: y - boxH, width: CW, height: boxH, color: LIGHT });
  left.forEach((t, i) => page.drawText(t, { x: L + 8, y: y - 16 - i * 13, size: 9.5, font: i === 0 ? bold : font, color: BLACK }));
  right.forEach(([k, v], i) => { page.drawText(k + ': ', { x: L + 95 * MM, y: y - 16 - i * 13, size: 9.5, font: bold, color: BLACK });
    page.drawText(safe(v), { x: L + 95 * MM + bold.widthOfTextAtSize(k + ': ', 9.5), y: y - 16 - i * 13, size: 9.5, font, color: BLACK }); });
  y -= boxH + 6;

  const G = V.G, n = V.n;
  let k = 0;
  if (G.catch_up.length) {
    heading(`${++k}. Catch-up work (one-off)${V.catchHead.suffix}`);
    G.catch_up.forEach((l) => row(lineLabel(l, V.catchHead.hideLabel), gbp(l.total), { was: was(l) }));
    row('Total catch-up work (paid once)', gbp(V.catchTotal), { hl: true });
  }
  if (G.sa.length) {
    heading(`${++k}. Self Assessment`);
    G.sa.forEach((l) => row(lineLabel(l), gbp(l.total), { was: was(l), note: `${gbp(Number(l.deposit))} when you accept, ${gbp(Number(l.balance))} before we submit your return to HMRC` }));
    row('Paid when you accept', gbp(V.saNow), { hl: true });
    if (Number(q.balance_later)) row('Balance before submission', gbp(Number(q.balance_later)), { hl: true });
  }
  if (G.year_end.length) {
    heading(`${++k}. Year-end services${V.yeHead}`);
    G.year_end.forEach((l) => row(lineLabel(l), gbp(l.total), { was: was(l) }));
    row('Total year-end services', gbp(V.yeTotal), { hl: true });
    if (n) row(`Spread over ${n} month${n === 1 ? '' : 's'}`, gbp(V.yePm) + ' a month', { hl: true });
  }
  if (G.monthly.length) {
    const months = G.monthly[0].months;
    heading(`${++k}. Monthly services – ongoing`);
    if (q.year_end_date) sub(`Until ${fd(q.year_end_date)}${months && months > 1 ? ` (${months} months)` : ''}`);
    G.monthly.forEach((l) => row(lineLabel(l), gbp(V.perMonth(l)) + ' a month', { was: was(l, true) }));
    row('Total monthly services', gbp(n ? V.msPm : (months ? r2(V.msTotal / months) : V.msTotal)) + ' a month', { hl: true });
  }
  const ongoing = Number(q.ongoing_total);
  if (ongoing > 0 && n) {
    heading(`${++k}. Your monthly fee`);
    if (G.year_end.length) row(`Year-end services (spread over ${n} months)`, gbp(V.yePm));
    if (G.monthly.length) row('Monthly services', gbp(V.msPm));
    bar('Total monthly fee', gbp(Number(q.monthly_amount)) + ' a month', `${n} payments, ${fd(q.first_payment_date)} to ${fd(q.last_payment_date)}`);
  } else if (ongoing > 0) {
    heading(`${++k}. Your fee for ongoing services`);
    bar('Ongoing services (one payment)', gbp(ongoing));
  }
  if (V.catchTotal) bar('One-off catch-up fee', gbp(V.catchTotal));
  if (G.sa.length) bar('Self Assessment – due when you accept', gbp(V.saNow), `${gbp(Number(q.balance_later))} balance before we submit your return`, NAVY);
  if (Number(q.discount_total)) { y -= 4; text(`These prices include a discount of ${gbp(Number(q.discount_total))}${q.discount_reason ? ' (' + q.discount_reason + ')' : ''}, which applies until ${fd(q.year_end_date) || 'your year end'}.`, { size: 8.5, color: GREY }); }
  if (ongoing > 0 && n) { y -= 4; text(`Prefer to pay the year in full? ${gbp(Number(q.one_off_due_now) + ongoing)} in one payment instead of the monthly fee — you choose when you accept.`, { size: 8.5, color: GREY }); }

  if (q.message_to_client?.trim()) { heading('Key information'); text(q.message_to_client.trim()); }
  heading('Notes');
  const notes = [
    `${p.name || 'Accounted4Tax Ltd'} is not VAT registered, so no VAT is added to these prices.`,
    'If the work needed changes (for example more employees or transactions, or extra services), we will tell you the cost before doing any extra work.',
    ongoing > 0 && n ? 'The monthly fee is collected automatically each month by card through Stripe and stops after the last payment.' : '',
    Number(q.balance_later) ? 'The Self Assessment balance is taken from the same card before we submit your return to HMRC.' : '',
    `${q.expires_at ? `This quote is valid until ${fd(q.expires_at)}. ` : ''}Click "Accept this quote" to read and sign our engagement letter and pay securely online.`,
  ].filter(Boolean);
  for (const s of notes) text('•  ' + s, { size: 8.5, color: GREY, gap: 3 });

  // Accept button → the client's private quote page
  need(60); y -= 12;
  const bw = 70 * MM, bh = 11 * MM, bx = (W - bw) / 2, byy = y - bh;
  page.drawRectangle({ x: bx, y: byy, width: bw, height: bh, color: TEAL });
  const label = 'Accept this quote';
  page.drawText(label, { x: bx + (bw - bold.widthOfTextAtSize(label, 12)) / 2, y: byy + bh / 2 - 4, size: 12, font: bold, color: WHITE });
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [bx, byy, bx + bw, byy + bh], Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(d.accept_url) } }));
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots) annots.push(link); else page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  y = byy - 6;
  const hint = safe(`Opens a secure page where you can accept and pay. You can also reply to our email${phone ? ' or call ' + phone : ''}.`);
  page.drawText(hint, { x: (W - font.widthOfTextAtSize(hint, 8)) / 2, y: y - 8, size: 8, font, color: GREY });
  return await doc.save();
}
