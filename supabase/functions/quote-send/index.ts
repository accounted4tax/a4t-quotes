// quote-send — admin only. Marks a quote as sent (sets expiry) and emails the client the secure link.
// Body: { quote_id }. Re-sending a quote that is already sent/viewed resends the email without
// changing the expiry date. Secrets: BREVO_API_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (s: number, code: string, message: string) => json({ error: { code, message } }, s);
const escHtml = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

export function layout(inner: string, practice: any) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1B1F27;max-width:580px;margin:0 auto;font-size:15px;line-height:1.5">
  <div style="background:#14213D;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0;font-size:19px"><b>Accounted4Tax</b></div>
  <div style="border:1px solid #E3E1DA;border-top:3px solid #B08D2A;padding:22px;border-radius:0 0 10px 10px">${inner}</div>
  <p style="color:#5F6675;font-size:12px;margin-top:14px">${escHtml(practice.name || 'Accounted4Tax Ltd')} · Company no. ${escHtml(practice.crn || '16438537')} · Registered office: ${escHtml(practice.registered_office || '128 City Road, London EC1V 2NX')} · ${escHtml(practice.email || 'info@accounted4tax.co.uk')}</p></div>`;
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
  const key = Deno.env.get('BREVO_API_KEY');
  if (!key) return fail(503, 'not_configured', 'Brevo API key has not been added yet.');
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { quote_id } = await req.json().catch(() => ({}));
  if (!quote_id) return fail(400, 'bad_request', 'quote_id is required.');
  const { data: q } = await db.from('qs_quotes').select('*, client:qs_clients(*)').eq('id', quote_id).single();
  if (!q) return fail(404, 'not_found', 'Quote not found.');
  if (!['draft', 'sent', 'viewed'].includes(q.status)) return fail(409, 'wrong_status', `A ${q.status} quote cannot be sent.`);
  const { count } = await db.from('qs_quote_lines').select('id', { count: 'exact', head: true }).eq('quote_id', quote_id);
  if (!count) return fail(400, 'empty', 'The quote has no services.');

  const { data: st } = await db.from('qs_settings').select('key,value');
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  const { data: tpl } = await db.from('qs_email_templates').select('*').eq('template_key', 'quote_sent').single();
  const practice = S.practice || {};
  const sender = S.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };

  const now = new Date();
  const firstSend = q.status === 'draft';
  const expires = firstSend ? new Date(now.getTime() + Number(S.quote_expiry_days || 30) * 86400000).toISOString() : q.expires_at;
  const base = String(S.app_base_url || 'https://accounted4tax.github.io/a4t-quotes').replace(/\/$/, '');
  const link = `${base}/q.html?t=${q.access_token}`;
  const c = q.client;
  const first = String(c.full_name || '').trim().split(/\s+/)[0] || 'there';
  const vars = {
    client_first_name: escHtml(first), quote_number: escHtml(q.quote_number), quote_link: link,
    expiry_date: escHtml(fmt(expires)),
    message_block: q.message_to_client ? `<p style="background:#F7F5F0;border-left:3px solid #B08D2A;padding:10px 14px">${escHtml(q.message_to_client).replace(/\n/g, '<br>')}</p>` : '',
  };
  const subject = fill(tpl?.subject || 'Your quote from Accounted4Tax ({{quote_number}})', { ...vars, quote_number: q.quote_number });
  const html = layout(fill(tpl?.body_html || '<p><a href="{{quote_link}}">View your quote</a></p>', vars), practice);

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, replyTo: sender, to: [{ email: c.email, name: c.full_name }], subject, htmlContent: html }),
  });
  const out = await res.json().catch(() => ({}));
  const ok = res.ok;
  await db.from('qs_email_log').insert({ client_id: c.id, quote_id: q.id, template_key: 'quote_sent', to_email: c.email, subject, status: ok ? 'sent' : 'failed', brevo_message_id: out.messageId || null, error: ok ? null : (out.message || `HTTP ${res.status}`) });
  if (!ok) return fail(502, 'brevo_error', out.message || `Brevo returned ${res.status}`);

  const upd: Record<string, unknown> = { sent_to_email: c.email };
  if (firstSend) Object.assign(upd, { status: 'sent', sent_at: now.toISOString(), expires_at: expires, reminder_1_sent_at: null, reminder_2_sent_at: null });
  await db.from('qs_quotes').update(upd).eq('id', q.id);
  await db.from('qs_events').insert({ source: 'admin', event_type: firstSend ? 'quote_sent' : 'quote_resent', client_id: c.id, quote_id: q.id, payload: { to: c.email, version: q.version } });
  return json({ sent: true, to: c.email, expires_at: expires, link });
});
