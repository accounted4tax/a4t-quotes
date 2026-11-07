// send-email
// ---------------------------------------------------------------------------
// Sends one email through Brevo (transactional API) and logs it in qs_email_log.
//
// CALL IT (admin pages, signed in):
//   supabase.functions.invoke('send-email', { body: {
//     to: 'client@example.com', to_name: 'Jane Smith',
//     subject: 'Your quote', html: '<p>...</p>',
//     template_key?: 'quote_sent', client_id?: uuid, quote_id?: uuid,
//     attachments?: [{ name: 'quote.pdf', content_base64: '...' }] } })
//   Special: { test: true } sends a test email to the admin_notify_email setting.
//
// Sender comes from qs_settings.email_sender (default Accounted4Tax <info@accounted4tax.co.uk>).
// SECRETS: BREVO_API_KEY (Brevo key restricted to Transactional email).
// Only signed-in admins (qs_is_admin) can call it. Other Edge Functions send email
// with the same Brevo call server-side.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return fail(401, 'unauthorised', 'Sign in first.');
  const userSb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await userSb.rpc('qs_is_admin');
  if (!isAdmin) return fail(403, 'forbidden', 'Not allowed.');

  const key = Deno.env.get('BREVO_API_KEY');
  if (!key) return fail(503, 'not_configured', 'Brevo API key has not been added yet.');

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: settings } = await admin.from('qs_settings').select('key,value').in('key', ['email_sender', 'admin_notify_email']);
  const map = Object.fromEntries((settings || []).map((s: any) => [s.key, s.value]));
  const sender = map.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };

  const body = await req.json().catch(() => ({}));
  let { to, to_name, subject, html, template_key, client_id, quote_id, attachments } = body;
  if (body.test) {
    to = map.admin_notify_email || sender.email;
    to_name = 'Accounted4Tax';
    subject = 'A4T Quotes: test email';
    template_key = 'test';
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
    html = `<div style="font-family:Arial,sans-serif;color:#1B1F27;max-width:560px">
      <div style="background:#14213D;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-size:18px">
        <b>Accounted4Tax</b> <span style="color:#B08D2A">· A4T Quotes</span></div>
      <div style="border:1px solid #E3E1DA;border-top:0;padding:20px;border-radius:0 0 10px 10px">
        <p>This is a test email from your quote system, sent ${when}.</p>
        <p>If it arrived in your inbox (not spam), email sending is working.</p>
        <p style="color:#5F6675;font-size:13px">Accounted4Tax Ltd · Company no. 16438537 · 128 City Road, London EC1V 2NX</p>
      </div></div>`;
  }
  if (!to || !EMAIL_RE.test(String(to))) return fail(400, 'bad_request', 'A valid "to" email address is required.');
  if (!subject || !html) return fail(400, 'bad_request', '"subject" and "html" are required.');

  const payload: Record<string, unknown> = {
    sender: { name: sender.name, email: sender.email },
    replyTo: { name: sender.name, email: sender.email },
    to: [{ email: String(to), ...(to_name ? { name: String(to_name) } : {}) }],
    subject: String(subject),
    htmlContent: String(html),
  };
  if (Array.isArray(attachments) && attachments.length) {
    payload.attachment = attachments.map((a: any) => ({ name: a.name, content: a.content_base64 }));
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  const ok = res.status >= 200 && res.status < 300;

  await admin.from('qs_email_log').insert({
    client_id: client_id || null, quote_id: quote_id || null, template_key: template_key || null,
    to_email: String(to), subject: String(subject), status: ok ? 'sent' : 'failed',
    brevo_message_id: ok ? (out.messageId || null) : null,
    error: ok ? null : (out.message || `Brevo HTTP ${res.status}`),
  });

  if (!ok) {
    const msg = res.status === 401 ? 'Brevo rejected the API key. Check BREVO_API_KEY and its permissions.'
      : (out.message || `Brevo returned ${res.status}`);
    return fail(502, 'brevo_error', msg);
  }
  return json({ sent: true, to, message_id: out.messageId || null });
});
