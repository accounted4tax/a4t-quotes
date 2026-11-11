// quote-accept — PUBLIC (no login), used by the client's signing page sign.html with the secret quote link token.
//   { action: 'loe', token, preview? }      → the engagement letter assembled for this quote (+ tick boxes, fingerprint)
//   { action: 'accept', token, quote_version, fingerprint, signed_name, ticks, payment_option }
//        → checks everything, records the acceptance (name, time, IP, device, quote version, ticks), builds the signed PDF
//          (letter + acceptance record + quote), saves it privately, adds the signed letter to the client's record in the
//          Practice Manager (loes + documents), marks the quote accepted and emails the client and Eduard.
//   { action: 'download', token }           → a fresh 1-hour link to the signed PDF (accepted quotes only)
// Phase 5, 11 Nov 2026. Secrets: BREVO_API_KEY.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { assembleLoe, sha256Hex, type Templates } from './loe.ts';
import { buildSignedPdf } from './loe-pdf.ts';
import { buildQuotePdf } from './quote-doc.ts';

const BUCKET = 'qs-signed-docs';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (s: number, code: string, message: string) => json({ error: { code, message } }, s);
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
function b64(bytes: Uint8Array) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
const fmtDT = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

// Templates live in qs_loe_templates (latest active version). First use seeds version 1 from loe/loe-v1.json on the site.
async function loadTemplates(base: string): Promise<Templates> {
  const { data } = await db.from('qs_loe_templates').select('template_key,template_type,title,body,version').eq('is_active', true).order('version', { ascending: false });
  let rows = data || [];
  if (!rows.length) {
    const r = await fetch(`${base}/loe/loe-v1.json`, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('templates_missing');
    const t = await r.json();
    const ins: any[] = [
      ['part_a', 'general', 'Engagement letter', t.part_a], ['acceptance', 'general', 'Acceptance', t.acceptance],
      ['part_b', 'general', 'Standard terms and conditions of business', t.part_b], ['part_c', 'general', 'Privacy notice', t.part_c],
      ['part_e', 'general', 'Cancellation form', t.part_e], ['schedule_open', 'general', 'Schedule opening line', t.schedule_open],
      ['schedule_close', 'general', 'Schedule closing paragraphs', t.schedule_close],
      ...Object.entries(t.schedules).map(([k, v]: any) => [k, 'schedule', v.title, v.body]),
    ].map(([template_key, template_type, title, body]) => ({ template_key, template_type, title, body, version: t.version || 1, is_active: true }));
    const { error } = await db.from('qs_loe_templates').upsert(ins, { onConflict: 'template_key,version' });
    if (error) throw new Error('templates_seed: ' + error.message);
    rows = ins;
  }
  const v = rows[0].version, cur = rows.filter((r: any) => r.version === v);
  const get = (k: string) => cur.find((r: any) => r.template_key === k)?.body || '';
  const schedules: Record<string, { title: string; body: string }> = {};
  cur.filter((r: any) => r.template_type === 'schedule').sort((a: any, b: any) => a.template_key.localeCompare(b.template_key, 'en', { numeric: true }))
    .forEach((r: any) => { schedules[r.template_key] = { title: r.title, body: r.body }; });
  return { version: v, part_a: get('part_a'), acceptance: get('acceptance'), part_b: get('part_b'), part_c: get('part_c'), part_e: get('part_e'),
    schedule_open: get('schedule_open'), schedule_close: get('schedule_close'), schedules };
}

async function load(token: string) {
  const { data: q } = await db.from('qs_quotes').select('*, client:clients(*)').eq('access_token', token).maybeSingle();
  if (!q) return null;
  const { data: lines } = await db.from('qs_quote_lines').select('*').eq('quote_id', q.id).order('sort_order');
  const ids = (lines || []).map((l: any) => l.service_id).filter(Boolean);
  const { data: svc } = ids.length ? await db.from('services_catalogue').select('id,description,loe_schedule_key').in('id', ids) : { data: [] as any[] };
  const services = Object.fromEntries((svc || []).map((s: any) => [s.id, s]));
  const { data: st } = await db.from('qs_settings').select('key,value');
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  return { q, c: q.client, lines: lines || [], services, S };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const body = await req.json().catch(() => ({}));
  const token = String(body.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return fail(404, 'not_found', 'This quote link is not valid.');
  const L = await load(token);
  if (!L) return fail(404, 'not_found', 'This quote link is not valid.');
  const { q, c, lines, services, S } = L;
  const practice = S.practice || {};
  const base = String(S.app_base_url || 'https://accounted4tax.github.io/a4t-quotes').replace(/\/$/, '');
  const clientDisplay = c.client_type === 'ltd' ? (c.company_name || c.full_name) : (c.trading_name ? `${c.full_name} (${c.trading_name})` : c.full_name);

  try {
    // ---------- download the signed PDF again ----------
    if (body.action === 'download') {
      const { data: acc } = await db.from('qs_acceptances').select('pdf_path').eq('quote_id', q.id).order('signed_at', { ascending: false }).limit(1).maybeSingle();
      if (!acc?.pdf_path) return fail(404, 'not_found', 'No signed copy yet.');
      const { data: u } = await db.storage.from(BUCKET).createSignedUrl(acc.pdf_path, 3600, { download: `Engagement letter ${q.quote_number}.pdf` });
      return json({ url: u?.signedUrl || null });
    }

    const T = await loadTemplates(base);
    const loe = assembleLoe(T, { quote: q, client: c, lines, services, practice, payment_option: body.payment_option === 'monthly' ? 'monthly' : 'one_off' });
    const fingerprint = await sha256Hex(loe.text);

    // ---------- show the letter ----------
    if (body.action === 'loe') {
      if (q.status === 'draft' && !body.preview) return fail(409, 'being_updated', 'This quote is being updated. We will email you when it is ready.');
      let accepted = null;
      if (['accepted', 'paid'].includes(q.status)) {
        const { data: a } = await db.from('qs_acceptances').select('signed_name,signed_at,quote_version').eq('quote_id', q.id).order('signed_at', { ascending: false }).limit(1).maybeSingle();
        accepted = a;
      }
      return json({
        quote: { quote_number: q.quote_number, version: q.version, status: q.status, expires_at: q.expires_at, monthly_allowed: q.monthly_allowed, client_type: c.client_type },
        client: { name: clientDisplay, signer: c.full_name, company_name: c.company_name },
        loe: { parts: loe.parts, intro: loe.intro, items: loe.items, schedules: loe.schedules, consumer: loe.consumer, template_version: loe.template_version },
        fingerprint, accepted,
      });
    }

    // ---------- accept and sign ----------
    if (body.action !== 'accept') return fail(400, 'bad_request', 'Unknown action.');
    if (['accepted', 'paid'].includes(q.status)) return fail(409, 'already_accepted', 'This quote has already been accepted.');
    if (!['sent', 'viewed'].includes(q.status)) return fail(409, 'not_open', q.status === 'expired' ? 'This quote has expired. Please contact us for an updated quote.' : 'This quote is not open for acceptance.');
    if (q.expires_at && new Date(q.expires_at) < new Date()) return fail(409, 'expired', 'This quote has expired. Please contact us for an updated quote.');
    if (Number(body.quote_version) !== Number(q.version)) return fail(409, 'changed', 'This quote has just been updated. Please reload the page to see the latest version.');
    if (String(body.fingerprint || '') !== fingerprint) return fail(409, 'changed', 'The engagement letter has changed since you opened it. Please reload the page.');
    const name = String(body.signed_name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (name.length < 3 || !/[a-z]{2,}/i.test(name)) return fail(400, 'name', 'Please type your full name as your signature.');
    const ticks: Record<string, boolean> = {};
    for (const it of loe.items) ticks[it.key] = body.ticks?.[it.key] === true;
    const missing = loe.items.filter((i) => i.required && !ticks[i.key]);
    if (missing.length) return fail(400, 'ticks', 'Please tick the boxes marked required.');
    const payment_option: 'one_off' | 'monthly' = q.monthly_allowed && body.payment_option === 'monthly' ? 'monthly' : 'one_off';
    if (q.monthly_allowed && !['monthly', 'one_off'].includes(body.payment_option)) return fail(400, 'payment', 'Please choose how you would like to pay.');
    const loeFinal = assembleLoe(T, { quote: q, client: c, lines, services, practice, payment_option });

    const now = new Date();
    const ip = (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '').split(',')[0].trim();
    const ua = (req.headers.get('user-agent') || '').slice(0, 400);

    // quote PDF (same as the one emailed) + letter + acceptance record
    const link = `${base}/q.html?t=${q.access_token}`;
    const quotePdf = await buildQuotePdf({
      practice, accept_url: link, quote: q,
      client: { client_type: c.client_type, contact: c.full_name, company_name: c.company_name, trading_name: c.trading_name, crn: c.crn, name: clientDisplay },
      lines: lines.map((l: any) => ({ description: l.description, about: services[l.service_id]?.description || null, period_label: l.period_label, quantity: l.quantity, unit_label: l.unit_label,
        unit_price: l.unit_price, is_earlier_year: l.is_earlier_year, pricing_type: l.pricing_type, months: l.months, price_period: l.price_period, kind: l.charge_kind,
        gross: Number(l.gross_amount), discount: Number(l.discount_amount), total: Number(l.line_total), deposit: l.deposit_amount, balance: l.balance_amount, rolling: !!l.runs_until_cancelled })),
    });
    const pdf = await buildSignedPdf({ loe: loeFinal, ticks, signed_name: name, signed_at: now, ip, user_agent: ua, quote_number: q.quote_number, quote_version: q.version,
      fingerprint, client_display: clientDisplay, quotePdf, practice });

    const path = `${c.id}/${q.quote_number}-v${q.version}-signed-${now.toISOString().slice(0, 10)}.pdf`;
    const up = await db.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true });
    if (up.error) throw new Error('storage: ' + up.error.message);

    // Practice Manager record: signed engagement letter + document link
    const { data: pmLoe, error: le } = await db.from('loes').insert({
      client_id: c.id, status: 'signed', services_covered: lines.map((l: any) => l.description), fee_summary: loeFinal.payment_summary,
      issued_date: String(q.sent_at || q.created_at).slice(0, 10), signed_date: now.toISOString().slice(0, 10), signed_file_url: `${BUCKET}/${path}`,
      tax_year: q.tax_year, notes: `Signed online by ${name} · quote ${q.quote_number} v${q.version} · schedules ${loeFinal.schedules.join(', ')}`,
    }).select('id').single();
    if (le) throw new Error('loes: ' + le.message);
    await db.from('documents').insert({ client_id: c.id, loe_id: pmLoe.id, category: 'loe', file_name: `Engagement letter ${q.quote_number} (signed).pdf`, file_url: `${BUCKET}/${path}`,
      file_size: pdf.length, mime_type: 'application/pdf', tax_year: q.tax_year, uploaded_by: 'client', verified: true, visible_to_client: true });

    const { data: acc, error: ae } = await db.from('qs_acceptances').insert({
      quote_id: q.id, quote_version: q.version, signed_name: name, signed_at: now.toISOString(), ip_address: ip || null, user_agent: ua || null,
      payment_option, loe_template_versions: { version: loeFinal.template_version, schedules: loeFinal.schedules }, loe_html_snapshot: loeFinal.text,
      pdf_path: path, client_id: c.id, consumer_start_now: loeFinal.consumer ? ticks.start_now === true : null, marketing_consent: ticks.marketing === true,
      loe_sha256: fingerprint, pm_loe_id: pmLoe.id, schedules: loeFinal.schedules,
    }).select('id').single();
    if (ae) throw new Error('acceptance: ' + ae.message);
    await db.from('qs_quotes').update({ status: 'accepted', accepted_at: now.toISOString(), payment_option }).eq('id', q.id);
    await db.from('qs_events').insert({ source: 'client', event_type: 'quote_accepted', client_id: c.id, quote_id: q.id,
      payload: { acceptance_id: acc.id, version: q.version, payment_option, ip, start_now: ticks.start_now ?? null } });

    // emails (failures are logged, never block the acceptance)
    const key = Deno.env.get('BREVO_API_KEY');
    if (key) {
      const sender = S.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };
      const { data: tpls } = await db.from('qs_email_templates').select('*').in('template_key', ['quote_accepted_client', 'quote_accepted_admin']);
      const tpl = (k: string) => (tpls || []).find((t: any) => t.template_key === k && t.is_active);
      const vars: Record<string, string> = {
        client_first_name: esc(String(c.full_name || '').split(/\s+/)[0] || 'there'), quote_number: esc(q.quote_number), quote_version: String(q.version),
        company_for: c.client_type === 'ltd' && c.company_name ? ' for ' + esc(c.company_name) : '', client_display: esc(clientDisplay),
        payment_summary: esc(loeFinal.payment_summary), phone: esc(practice.phone || ''), signed_name: esc(name), accepted_at: esc(fmtDT(now)),
        consumer_block: loeFinal.consumer ? (ticks.start_now ? '<p>You asked us to start work straight away. You can still cancel within 14 days; if you do, you pay only for the work done until then.</p>'
          : '<p>You have 14 days to cancel. As you did not ask us to start straight away, we will start work once the 14 days have passed.</p>') : '',
        start_now_line: loeFinal.consumer ? (ticks.start_now ? 'Consumer: asked us to START NOW within the 14-day cancellation period.' : 'Consumer: did NOT ask to start within 14 days — work starts after the cancellation period.') : 'Company client (no consumer cancellation period).',
      };
      const layout = (inner: string) => `<div style="background:#F5F6F8;padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#14213D;max-width:560px;margin:0 auto;font-size:15px;line-height:1.55"><div style="background:#14213D;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">Accounted4Tax</div><div style="background:#fff;padding:22px 18px;border-radius:0 0 10px 10px">${inner}</div><p style="color:#4A5568;font-size:12px;text-align:center;margin-top:14px">${esc(practice.name || 'Accounted4Tax Ltd')} · ${esc(practice.registered_office || '128 City Road, London EC1V 2NX')} · ${esc(practice.email || 'info@accounted4tax.co.uk')}${practice.phone ? ' · ' + esc(practice.phone) : ''}</p></div></div>`;
      const att = [{ name: `Engagement letter and quote ${q.quote_number} (signed).pdf`, content: b64(pdf) }];
      const send = async (k: string, to: { email: string; name?: string }) => {
        const t = tpl(k); if (!t || !to.email) return;
        const subject = fill(t.subject, { ...vars, client_display: clientDisplay, quote_number: q.quote_number });
        const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ sender, replyTo: sender, to: [to], subject, htmlContent: layout(fill(t.body_html, vars)), attachment: att, tags: [k] }) });
        const out = await res.json().catch(() => ({}));
        await db.from('qs_email_log').insert({ client_id: c.id, quote_id: q.id, template_key: k, to_email: to.email, subject, status: res.ok ? 'sent' : 'failed', brevo_message_id: out.messageId || null, error: res.ok ? null : (out.message || `HTTP ${res.status}`) });
      };
      await send('quote_accepted_client', { email: c.email, name: c.full_name });
      const admin = typeof S.admin_notify_email === 'string' ? S.admin_notify_email : (S.admin_notify_email?.email || 'info@accounted4tax.co.uk');
      await send('quote_accepted_admin', { email: admin, name: 'Eduard' });
    }

    const { data: u } = await db.storage.from(BUCKET).createSignedUrl(path, 3600, { download: `Engagement letter ${q.quote_number}.pdf` });
    return json({ accepted: true, signed_at: now.toISOString(), download_url: u?.signedUrl || null, payment_option });
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    await db.from('qs_events').insert({ source: 'system', event_type: 'quote_accept_error', client_id: c.id, quote_id: q.id, payload: { action: body.action, error: msg } });
    return fail(500, 'server', 'Something went wrong. Please try again, or reply to our email.');
  }
});
