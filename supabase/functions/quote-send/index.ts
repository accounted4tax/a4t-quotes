// quote-send — admin only.
//   { quote_id }                 → emails the client the quote: cover email (template 'quote_sent'), the quote PDF
//                                   attached and a "View and accept the quote" button with the secure link.
//                                   First send marks the quote sent and sets the expiry date; resends keep the expiry.
//   { quote_id, pdf_only: true } → returns the quote PDF (base64) for download; works for drafts too, sends nothing.
// Same way of sending as the Letters app's practice quotes (cover email + PDF + button), 7 Nov 2026.
// Secrets: BREVO_API_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildQuotePdf } from './quote-doc.ts';

// Table names in one place: the Practice Manager's clients / services_catalogue (shared since 9 Nov 2026).
const CLIENTS = 'clients', SERVICES = 'services_catalogue';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (s: number, code: string, message: string) => json({ error: { code, message } }, s);
const escHtml = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
function b64(bytes: Uint8Array) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

export function layout(inner: string, practice: any) {
  return `<div style="background:#F5F6F8;padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#14213D;max-width:560px;margin:0 auto;font-size:15px;line-height:1.55">
  <div style="background:#14213D;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">Accounted4Tax</div>
  <div style="background:#fff;padding:22px 18px;border-radius:0 0 10px 10px">${inner}</div>
  <p style="color:#4A5568;font-size:12px;text-align:center;margin-top:14px">${escHtml(practice.name || 'Accounted4Tax Ltd')} · ${escHtml(practice.registered_office || '128 City Road, London EC1V 2NX')} · ${escHtml(practice.email || 'info@accounted4tax.co.uk')}${practice.phone ? ' · ' + escHtml(practice.phone) : ''}</p></div></div>`;
}
export function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return fail(401, 'unauthorised', 'Sign in first.');
  const userSb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: isAdmin } = await userSb.rpc('qs_is_admin');
  if (!isAdmin) return fail(403, 'forbidden', 'Not allowed.');
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { quote_id, pdf_only } = await req.json().catch(() => ({}));
  if (!quote_id) return fail(400, 'bad_request', 'quote_id is required.');
  const { data: q } = await db.from('qs_quotes').select(`*, client:${CLIENTS}(*)`).eq('id', quote_id).single();
  if (!q) return fail(404, 'not_found', 'Quote not found.');
  const { data: lines } = await db.from('qs_quote_lines').select('*').eq('quote_id', quote_id).order('sort_order');
  if (!lines?.length) return fail(400, 'empty', 'The quote has no services.');
  if (!pdf_only && !['draft', 'sent', 'viewed'].includes(q.status)) return fail(409, 'wrong_status', `A ${q.status} quote cannot be sent.`);

  const { data: st } = await db.from('qs_settings').select('key,value');
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  const practice = S.practice || {};
  const sender = S.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };
  const ids = lines.map((l: any) => l.service_id).filter(Boolean);
  const { data: svc } = ids.length ? await db.from(SERVICES).select('id,description').in('id', ids) : { data: [] as any[] };
  const about = Object.fromEntries((svc || []).map((s: any) => [s.id, s.description]));

  const now = new Date();
  const firstSend = q.status === 'draft' && !pdf_only;
  const expires = firstSend ? new Date(now.getTime() + Number(S.quote_expiry_days || 30) * 86400000).toISOString() : q.expires_at;
  const base = String(S.app_base_url || 'https://accounted4tax.github.io/a4t-quotes').replace(/\/$/, '');
  const link = `${base}/q.html?t=${q.access_token}`;
  const c = q.client;

  const view = {
    practice, accept_url: link,
    quote: { ...q, expires_at: expires, sent_at: firstSend ? now.toISOString() : q.sent_at },
    client: { client_type: c.client_type, contact: c.full_name, company_name: c.company_name, trading_name: c.trading_name, crn: c.crn,
      name: c.client_type === 'ltd' ? c.company_name : (c.trading_name || c.full_name) },
    lines: lines.map((l: any) => ({ description: l.description, about: about[l.service_id] || null, period_label: l.period_label, quantity: l.quantity, unit_label: l.unit_label,
      unit_price: l.unit_price, is_earlier_year: l.is_earlier_year, pricing_type: l.pricing_type, months: l.months, price_period: l.price_period, kind: l.charge_kind,
      gross: Number(l.gross_amount), discount: Number(l.discount_amount), total: Number(l.line_total), deposit: l.deposit_amount, balance: l.balance_amount, rolling: !!l.runs_until_cancelled })),
  };
  const who = c.client_type === 'ltd' ? c.company_name : (c.trading_name || c.full_name);
  const fileName = `Quote ${q.quote_number}${who ? ' – ' + who : ''}.pdf`.replace(/[\/\\:*?"<>|]/g, ' ');
  let pdf: Uint8Array;
  try { pdf = await buildQuotePdf(view); }
  catch (e) { return fail(500, 'pdf_failed', 'Could not build the PDF: ' + String((e as Error).message || e).slice(0, 200)); }
  if (pdf_only) return json({ pdf: b64(pdf), name: fileName });

  const key = Deno.env.get('BREVO_API_KEY');
  if (!key) return fail(503, 'not_configured', 'Brevo API key has not been added yet.');
  const { data: tpl } = await db.from('qs_email_templates').select('*').eq('template_key', 'quote_sent').single();
  const first = String(c.full_name || '').trim().split(/\s+/)[0] || 'there';
  const vars: Record<string, string> = {
    client_first_name: escHtml(first), quote_number: escHtml(q.quote_number), quote_link: link,
    company_for: c.client_type === 'ltd' && c.company_name ? ' for ' + escHtml(c.company_name) : '',
    company_dash: who ? ' – ' + escHtml(who) : '',
    expiry_date: escHtml(fmt(expires)), phone: escHtml(practice.phone || ''),
    message_block: q.message_to_client ? `<p style="background:#F7F5F0;border-left:3px solid #B08D2A;padding:10px 14px">${escHtml(q.message_to_client).replace(/\n/g, '<br>')}</p>` : '',
  };
  const subject = fill(tpl?.subject || 'Your quote from Accounted4Tax{{company_dash}}', { ...vars, company_dash: who ? ' – ' + who : '' });
  const html = layout(fill(tpl?.body_html || '<p><a href="{{quote_link}}">View and accept the quote</a></p>', vars), practice);

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, replyTo: sender, to: [{ email: c.email, name: c.full_name }], subject, htmlContent: html,
      attachment: [{ name: fileName, content: b64(pdf) }], tags: ['quote_sent'] }),
  });
  const out = await res.json().catch(() => ({}));
  const ok = res.ok;
  await db.from('qs_email_log').insert({ client_id: c.id, quote_id: q.id, template_key: 'quote_sent', to_email: c.email, subject, status: ok ? 'sent' : 'failed', brevo_message_id: out.messageId || null, error: ok ? null : (out.message || `HTTP ${res.status}`) });
  if (!ok) return fail(502, 'brevo_error', out.message || `Brevo returned ${res.status}`);

  const upd: Record<string, unknown> = { sent_to_email: c.email };
  if (firstSend) Object.assign(upd, { status: 'sent', sent_at: now.toISOString(), expires_at: expires, reminder_1_sent_at: null, reminder_2_sent_at: null });
  await db.from('qs_quotes').update(upd).eq('id', q.id);
  await db.from('qs_events').insert({ source: 'admin', event_type: firstSend ? 'quote_sent' : 'quote_resent', client_id: c.id, quote_id: q.id, payload: { to: c.email, version: q.version, pdf: fileName } });
  return json({ sent: true, to: c.email, expires_at: expires, link });
});
