// stripe-webhook — Stripe calls this after payments. PUBLIC URL, but every call is checked with the webhook signing
// secret (STRIPE_WEBHOOK_SECRET); anything not signed by Stripe is rejected. Each event is handled once (qs_events.external_id).
//   checkout.session.completed      → quote paid; Stripe customer/payment/subscription saved; monthly fee limited to the quoted
//                                     number of payments with a subscription schedule (plans until cancelled carry on after).
//   invoice.paid                    → invoice saved (number, amount, PDF link); monthly payments counted; overdue flag cleared.
//   invoice.payment_failed          → subscription flagged "payment overdue"; Eduard emailed (Stripe retries automatically).
//   customer.subscription.updated   → client asked to cancel (portal) → Eduard emailed.
//   customer.subscription.deleted   → subscription "completed" (all payments made) or "cancelled" (Eduard emailed).
// Phase 6, 11 Nov 2026. Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BREVO_API_KEY.
// 12 Nov 2026: one-off online services without an identity check (services_catalogue.requires_id = false) get the
// welcome_oneoff_client email (with their next step) and no automatic ID request.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { stripe, verifyWebhook } from './stripe.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const ok = (b: unknown = { received: true }) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const day = (ts?: number | null) => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
const gbp = (p: number) => '£' + (Number(p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// metadata we put on the session / subscription / invoice
const metaOf = (o: any) => ({ ...(o?.parent?.subscription_details?.metadata || {}), ...(o?.subscription_details?.metadata || {}), ...(o?.metadata || {}) });
const subIdOf = (inv: any) => inv?.parent?.subscription_details?.subscription || inv?.subscription || null;

async function notifyAdmin(templateKey: string, vars: Record<string, string>, ids: { client_id?: string; quote_id?: string }) {
  const key = Deno.env.get('BREVO_API_KEY'); if (!key) return;
  const { data: t } = await db.from('qs_email_templates').select('*').eq('template_key', templateKey).eq('is_active', true).maybeSingle();
  if (!t) return;
  const { data: st } = await db.from('qs_settings').select('key,value').in('key', ['email_sender', 'admin_notify_email']);
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  const sender = S.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };
  const to = typeof S.admin_notify_email === 'string' ? S.admin_notify_email : (S.admin_notify_email?.email || 'info@accounted4tax.co.uk');
  const v = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, esc(x)]));
  const subject = fill(t.subject, vars);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#14213D;max-width:560px;margin:0 auto;font-size:15px;line-height:1.55"><div style="background:#14213D;color:#fff;padding:12px 16px;border-radius:10px 10px 0 0;font-weight:bold">A4T Quotes</div><div style="background:#fff;border:1px solid #E3E6EC;border-top:0;padding:18px 16px;border-radius:0 0 10px 10px">${fill(t.body_html, v)}</div></div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to, name: 'Eduard' }], subject, htmlContent: html, tags: [templateKey] }) });
  const out = await res.json().catch(() => ({}));
  await db.from('qs_email_log').insert({ client_id: ids.client_id || null, quote_id: ids.quote_id || null, template_key: templateKey, to_email: to, subject,
    status: res.ok ? 'sent' : 'failed', brevo_message_id: out.messageId || null, error: res.ok ? null : (out.message || `HTTP ${res.status}`) });
}

// one-off services sold online (services_catalogue.requires_id = false, e.g. CIS registration) have no identity check
async function needsId(quote_id: string) {
  const { data: ls } = await db.from('qs_quote_lines').select('service_id').eq('quote_id', quote_id);
  const ids = (ls || []).map((l: any) => l.service_id).filter(Boolean);
  if (!ids.length || ids.length < (ls || []).length) return true;
  const { data: sv } = await db.from('services_catalogue').select('id,requires_id').in('id', ids);
  return (sv || []).length < new Set(ids).size || (sv || []).some((x: any) => x.requires_id !== false);
}

// ---------- welcome email (client) + new client email (Eduard), once per quote ----------
function b64(bytes: Uint8Array) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
const fdate = (d?: string | null) => !d ? '' : new Date(String(d).length === 10 ? d + 'T12:00:00Z' : String(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const pounds = (n: number) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function sendTemplate(templateKey: string, to: { email: string; name?: string }, vars: Record<string, string>, ids: { client_id: string; quote_id: string },
  attachment?: { name: string; content: string }[], subjectVars?: Record<string, string>) {
  const key = Deno.env.get('BREVO_API_KEY'); if (!key || !to.email) return;
  const { data: sent } = await db.from('qs_email_log').select('id').eq('template_key', templateKey).eq('quote_id', ids.quote_id).eq('status', 'sent').limit(1);
  if (sent?.length) return; // never twice
  const { data: t } = await db.from('qs_email_templates').select('*').eq('template_key', templateKey).eq('is_active', true).maybeSingle();
  if (!t) return;
  const { data: st } = await db.from('qs_settings').select('key,value').in('key', ['email_sender', 'practice']);
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  const p = S.practice || {}, sender = S.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };
  const subject = fill(t.subject, subjectVars || vars);
  const html = `<div style="background:#F5F6F8;padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#14213D;max-width:560px;margin:0 auto;font-size:15px;line-height:1.55"><div style="background:#14213D;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">Accounted4Tax</div><div style="background:#fff;padding:22px 18px;border-radius:0 0 10px 10px">${fill(t.body_html, vars)}</div><p style="color:#4A5568;font-size:12px;text-align:center;margin-top:14px">${esc(p.name || 'Accounted4Tax Ltd')} · ${esc(p.registered_office || '128 City Road, London EC1V 2NX')} · ${esc(p.email || 'info@accounted4tax.co.uk')}${p.phone ? ' · ' + esc(p.phone) : ''}</p></div></div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, replyTo: sender, to: [to], subject, htmlContent: html, attachment, tags: [templateKey] }) });
  const out = await res.json().catch(() => ({}));
  await db.from('qs_email_log').insert({ client_id: ids.client_id, quote_id: ids.quote_id, template_key: templateKey, to_email: to.email, subject,
    status: res.ok ? 'sent' : 'failed', brevo_message_id: out.messageId || null, error: res.ok ? null : (out.message || `HTTP ${res.status}`) });
}

async function welcomeEmails(q: any, s: any, live: boolean) {
  const { data: c } = await db.from('clients').select('*').eq('id', q.client_id).single();
  const { data: lines } = await db.from('qs_quote_lines').select('description,period_label,is_earlier_year,line_total,runs_until_cancelled,charge_kind').eq('quote_id', q.id).order('sort_order');
  const { data: acc } = await db.from('qs_acceptances').select('pdf_path,signed_name,consumer_start_now').eq('quote_id', q.id).order('signed_at', { ascending: false }).limit(1).maybeSingle();
  const { data: st } = await db.from('qs_settings').select('key,value').in('key', ['app_base_url', 'practice', 'admin_notify_email']);
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  const base = String(S.app_base_url || 'https://accounted4tax.github.io/a4t-quotes').replace(/\/$/, '');
  const display = displayOf(c), ltd = c.client_type === 'ltd';
  const paid = Number(s.amount_total || 0) / 100;
  const monthly = q.payment_option === 'monthly' && q.monthly_allowed, n = Number(q.payments_count || 0), R = Number(q.rolling_monthly || 0);
  let pay = `${pounds(paid)} paid today`;
  if (monthly) pay += n > 1 ? `, then ${n - 1} monthly payment${n - 1 === 1 ? '' : 's'} of ${pounds(Number(q.monthly_amount) + R)} until ${fdate(q.last_payment_date)}` : '';
  if (R) pay += monthly && n > 1 ? `, then ${pounds(R)} a month until you cancel` : `, then ${pounds(R)} a month until you cancel`;
  pay += '.';
  if (Number(q.balance_later)) pay += ` The Self Assessment balance of ${pounds(Number(q.balance_later))} will be taken from the same card before we submit your return to HMRC.`;
  const hasSub = s.mode === 'subscription';

  // signed engagement letter + quote PDF
  let attachment: { name: string; content: string }[] | undefined;
  if (acc?.pdf_path) {
    const { data: f } = await db.storage.from('qs-signed-docs').download(acc.pdf_path);
    if (f) attachment = [{ name: `Engagement letter and quote ${q.quote_number} (signed).pdf`, content: b64(new Uint8Array(await f.arrayBuffer())) }];
  }
  const phone = (S.practice || {}).phone || '07563 811938';
  const ids = { client_id: c.id, quote_id: q.id };
  const withId = await needsId(q.id);
  if (!withId) {
    const { data: st2 } = await db.from('qs_settings').select('key,value').eq('key', 'website_base_url').maybeSingle();
    const web = String(st2?.value || 'https://accounted4tax.pages.dev').replace(/\/$/, '');
    const { data: form } = await db.from('form_submissions').select('access_token,form_type').eq('quote_id', q.id).maybeSingle();
    const btn = (href: string, label: string) => `<p style="text-align:center;margin:18px 0"><a href="${esc(href)}" style="background:#0E6E6B;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;
    const next = form?.form_type === 'cis301'
      ? `<p><b>Check and sign your CIS registration form.</b> We have filled in HMRC form CIS301 from your answers. Please check the details and sign on screen:</p>${btn(`${web}/cis-registration/sign/?t=${form.access_token}`, 'Check and sign my form')}<p>Once you have signed, we print the form and post it to HMRC. HMRC will write to you to confirm your registration.</p>`
      : '<p>We will be in touch shortly about the next step.</p>';
    await sendTemplate('welcome_oneoff_client', { email: c.email, name: c.full_name }, {
      client_first_name: esc(String(c.full_name || '').trim().split(/\s+/)[0] || 'there'), amount_paid: esc(pounds(paid)), quote_number: esc(q.quote_number),
      service_name: esc((lines || []).map((l: any) => l.description).join(', ')), next_step_block: next, phone: esc(phone),
      consumer_block: !ltd && !acc?.consumer_start_now ? '<p style="color:#4A5568;font-size:14px">You have 14 days from accepting to cancel. As you did not ask us to start straight away, we will post your form once that period has passed.</p>' : '',
    }, ids, attachment, { service_name: (lines || []).map((l: any) => l.description).join(', ') });
  } else
  await sendTemplate('welcome_client', { email: c.email, name: c.full_name }, {
    client_first_name: esc(String(c.full_name || '').trim().split(/\s+/)[0] || 'there'), amount_paid: esc(pounds(paid)), quote_number: esc(q.quote_number),
    company_for: ltd && c.company_name ? ' and ' + esc(c.company_name) : '', client_display: esc(display), payment_summary: esc(pay), phone: esc(phone),
    portal_url: esc(`${base}/portal.html?t=${q.access_token}`),
    cancel_block: hasSub ? `<p style="color:#4A5568;font-size:14px">To stop your monthly payments, please email us or call ${esc(phone)}. As set out in your engagement letter, we need 14 days' notice before the next payment.</p>` : '',
    consumer_block: !ltd ? (acc?.consumer_start_now ? '<p style="color:#4A5568;font-size:14px">You asked us to start work straight away. You can still cancel within 14 days of accepting; if you do, you pay only for work done until then.</p>'
      : '<p style="color:#4A5568;font-size:14px">You have 14 days from accepting to cancel. As you did not ask us to start straight away, we will start work once that period has passed (and your identity checks are complete).</p>') : '',
  }, ids, attachment, { client_display: display });

  const row = (k: string, v?: string | null) => v ? `<tr><td style="padding:4px 8px 4px 0;color:#4A5568;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>` : '';
  const typeLabel = ({ sole_trader: 'Sole trader', ltd: 'Limited company', landlord: 'Landlord' } as any)[c.client_type] || c.client_type;
  const admin = typeof S.admin_notify_email === 'string' ? S.admin_notify_email : (S.admin_notify_email?.email || 'info@accounted4tax.co.uk');
  await sendTemplate('new_client_admin', { email: admin, name: 'Eduard' }, {
    client_display: esc(display), amount_paid: esc(pounds(paid)), quote_number: esc(q.quote_number), payment_summary: esc(pay),
    detail_rows: [row('Type', typeLabel), row('Contact', c.full_name), row('Company', ltd ? c.company_name : c.trading_name), row('Company number', c.crn), row('CT UTR', c.ct_utr), row('SA UTR', c.utr),
      row('Email', c.email), row('Phone', c.phone), row('Address', c.address), row('Year end', fdate(q.year_end_date)), row('Signed by', acc?.signed_name)].join(''),
    services_list: (lines || []).map((l: any) => `<li>${esc(`${l.description}${l.is_earlier_year ? ' catch-up' : ''}${l.period_label ? ` (${l.period_label})` : ''}`)} – ${esc(pounds(Number(l.line_total)))}${l.runs_until_cancelled ? ' a month' : ''}</li>`).join(''),
    start_now_line: ltd ? 'Company client – no consumer cancellation period.' : acc?.consumer_start_now ? 'Consumer: asked us to START NOW within the 14-day cancellation period.' : 'Consumer: did NOT ask to start early – work starts after the 14-day cancellation period.',
    stripe_customer: esc(s.customer || ''), stripe_mode: live ? '' : ' (sandbox – test payment)',
  }, ids, attachment, { client_display: display, amount_paid: pounds(paid), quote_number: q.quote_number });
}

async function quoteInfo(quote_id?: string) {
  if (!quote_id) return null;
  const { data } = await db.from('qs_quotes').select('*, client:clients(id,full_name,company_name,trading_name,client_type,email)').eq('id', quote_id).maybeSingle();
  return data;
}
const displayOf = (c: any) => !c ? '' : c.client_type === 'ltd' ? (c.company_name || c.full_name) : (c.trading_name ? `${c.full_name} (${c.trading_name})` : c.full_name);

// ---------- handlers ----------
async function checkoutCompleted(s: any) {
  const m = metaOf(s), q = await quoteInfo(m.quote_id || s.client_reference_id);
  if (!q) return 'no_quote';
  if (!['paid', 'no_payment_required'].includes(s.payment_status)) return 'not_paid_yet';
  await db.from('clients').update({ stripe_customer_id: s.customer }).eq('id', q.client_id);
  const upd: any = { status: 'paid', paid_at: new Date().toISOString(), stripe_checkout_session_id: s.id };

  if (s.mode === 'payment') {
    upd.stripe_payment_intent_id = s.payment_intent;
    // card kept for the Self Assessment balance → make it the customer's default
    if (Number(q.balance_later) > 0 && s.payment_intent) {
      const pi = await stripe('GET', `payment_intents/${s.payment_intent}`);
      if (pi.payment_method) await stripe('POST', `customers/${s.customer}`, { invoice_settings: { default_payment_method: pi.payment_method } });
    }
  }

  if (s.mode === 'subscription' && s.subscription) {
    const sub = await stripe('GET', `subscriptions/${s.subscription}`, { expand: ['items.data.price.product'] });
    const its = sub.items.data.map((it: any) => ({ price: it.price.id, quantity: it.quantity || 1, kind: it.price.product?.metadata?.kind || 'rolling' }));
    const fixed = its.filter((x: any) => x.kind === 'fixed'), rolling = its.filter((x: any) => x.kind !== 'fixed');
    const n = Number(m.payments_count || q.payments_count || 0);
    let scheduleId: string | null = null;
    if (fixed.length && n >= 1) {
      // limit the monthly fee to n payments; plans until cancelled continue on their own after that
      const sch = await stripe('POST', 'subscription_schedules', { from_subscription: sub.id }, `sch-${sub.id}`);
      scheduleId = sch.id;
      const start = sch.phases[0].start_date;
      const phases: any[] = [{ items: its.map(({ price, quantity }: any) => ({ price, quantity })), start_date: start, duration: { interval: 'month', interval_count: n }, proration_behavior: 'none' }];
      if (rolling.length) phases.push({ items: rolling.map(({ price, quantity }: any) => ({ price, quantity })), proration_behavior: 'none' });
      await stripe('POST', `subscription_schedules/${sch.id}`, { phases, end_behavior: rolling.length ? 'release' : 'cancel', metadata: { quote_id: q.id, quote_number: q.quote_number } });
    }
    const R = Number(q.rolling_monthly || 0), monthlyFee = fixed.length ? Number(q.monthly_amount) : 0;
    await db.from('qs_subscriptions').upsert({
      client_id: q.client_id, quote_id: q.id, stripe_customer_id: s.customer, stripe_subscription_id: sub.id, stripe_schedule_id: scheduleId,
      status: 'active', monthly_amount: Math.round((monthlyFee + R) * 100) / 100, payments_total: fixed.length ? n : null, payments_made: 1,
      start_date: day(sub.start_date || sub.created), end_date: fixed.length && !rolling.length ? q.last_payment_date : null, last_payment_at: new Date().toISOString(),
    }, { onConflict: 'stripe_subscription_id' });
    // the first invoice can arrive before this event: link it to the subscription
    const { data: sr } = await db.from('qs_subscriptions').select('id').eq('stripe_subscription_id', sub.id).maybeSingle();
    if (sr) await db.from('qs_invoices').update({ subscription_id: sr.id }).eq('quote_id', q.id).is('subscription_id', null);
    // card kept for the Self Assessment balance → make it the customer's default too
    if (Number(q.balance_later) > 0 && sub.default_payment_method) await stripe('POST', `customers/${s.customer}`, { invoice_settings: { default_payment_method: sub.default_payment_method } });
  }
  await db.from('qs_quotes').update(upd).eq('id', q.id);
  await db.from('qs_events').insert({ source: 'stripe', event_type: 'quote_paid', client_id: q.client_id, quote_id: q.id,
    payload: { session: s.id, mode: s.mode, amount: s.amount_total, subscription: s.subscription || null } });
  try { await welcomeEmails({ ...q, ...upd }, s, !!s.livemode); }
  catch (e) { await db.from('qs_events').insert({ source: 'system', event_type: 'welcome_email_error', client_id: q.client_id, quote_id: q.id, payload: { error: String((e as Error).message || e).slice(0, 300) } }); }
  // identity check link for the contact person (directors and PSCs are requested later from the Practice Manager)
  if (await needsId(q.id)) try {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/aml`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'auto', quote_id: q.id }) });
  } catch (_) { /* logged by the aml function */ }
  return 'paid';
}

async function invoicePaid(inv: any, failed = false) {
  const m = metaOf(inv), subId = subIdOf(inv);
  let subRow: any = null;
  if (subId) { const { data } = await db.from('qs_subscriptions').select('*').eq('stripe_subscription_id', subId).maybeSingle(); subRow = data; }
  const quote_id = m.quote_id || subRow?.quote_id || null;
  const q = await quoteInfo(quote_id);
  const client_id = q?.client_id || subRow?.client_id || m.client_id || null;
  if (!client_id) return 'no_client';
  await db.from('qs_invoices').upsert({
    client_id, quote_id, subscription_id: subRow?.id || null, invoice_number: inv.number, description: inv.description || (inv.lines?.data?.[0]?.description) || null,
    amount: (failed ? inv.amount_due : inv.amount_paid) / 100, status: failed ? 'overdue' : 'paid', issued_date: day(inv.created), due_date: day(inv.due_date),
    paid_date: failed ? null : day(inv.status_transitions?.paid_at || inv.created), hosted_invoice_url: inv.hosted_invoice_url || null, invoice_pdf_url: inv.invoice_pdf || null,
    stripe_invoice_id: inv.id, tax_year: q?.tax_year || null, period_label: inv.billing_reason || null,
  }, { onConflict: 'stripe_invoice_id' });
  if (subRow) {
    if (failed) {
      await db.from('qs_subscriptions').update({ status: 'payment_overdue', updated_at: new Date().toISOString() }).eq('id', subRow.id);
      const att = inv.attempt_count || 1, next = inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'no further automatic attempts';
      await notifyAdmin('payment_failed_admin', { client_display: displayOf(q?.client), quote_number: q?.quote_number || '', amount: gbp(inv.amount_due), attempt: String(att), next_attempt: next,
        invoice_url: inv.hosted_invoice_url || '' }, { client_id, quote_id: quote_id || undefined });
    } else {
      const { count } = await db.from('qs_invoices').select('id', { count: 'exact', head: true }).eq('subscription_id', subRow.id).eq('status', 'paid');
      await db.from('qs_subscriptions').update({ status: subRow.status === 'payment_overdue' ? 'active' : subRow.status, payments_made: Math.max(count || 0, subRow.payments_made || 0),
        last_payment_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', subRow.id);
    }
  }
  return failed ? 'failed' : 'paid';
}

async function subscriptionChanged(sub: any, deleted: boolean) {
  const { data: row } = await db.from('qs_subscriptions').select('*').eq('stripe_subscription_id', sub.id).maybeSingle();
  if (!row) return 'unknown_subscription';
  const q = await quoteInfo(row.quote_id);
  if (deleted) {
    const completed = row.payments_total && (row.payments_made || 0) >= row.payments_total && !Number(q?.rolling_monthly || 0);
    await db.from('qs_subscriptions').update({ status: completed ? 'completed' : 'cancelled', cancelled_at: completed ? null : new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', row.id);
    if (!completed) await notifyAdmin('subscription_cancelled_admin', { client_display: displayOf(q?.client), quote_number: q?.quote_number || '', when: 'now',
      payments: `${row.payments_made || 0}${row.payments_total ? ' of ' + row.payments_total : ''}` }, { client_id: row.client_id, quote_id: row.quote_id });
    return completed ? 'completed' : 'cancelled';
  }
  // the schedule's own planned end is not a client cancellation
  if (sub.cancel_at_period_end || (sub.cancel_at && !sub.schedule)) {
    const when = new Date((sub.cancel_at || sub.current_period_end || sub.items?.data?.[0]?.current_period_end) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const { data: seen } = await db.from('qs_events').select('id').eq('event_type', 'cancel_requested').eq('quote_id', row.quote_id).limit(1);
    if (!seen?.length) {
      await db.from('qs_events').insert({ source: 'stripe', event_type: 'cancel_requested', client_id: row.client_id, quote_id: row.quote_id, payload: { subscription: sub.id, cancel_at: sub.cancel_at } });
      await notifyAdmin('subscription_cancelled_admin', { client_display: displayOf(q?.client), quote_number: q?.quote_number || '', when: 'from ' + when,
        payments: `${row.payments_made || 0}${row.payments_total ? ' of ' + row.payments_total : ''}` }, { client_id: row.client_id, quote_id: row.quote_id });
    }
    return 'cancel_requested';
  }
  return 'ignored';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Use POST', { status: 405 });
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const raw = await req.text();
  if (!secret || !(await verifyWebhook(raw, req.headers.get('stripe-signature'), secret))) return new Response('Bad signature', { status: 400 });
  const ev = JSON.parse(raw);

  // handle each event once
  const { data: prev } = await db.from('qs_events').select('id,processed_at').eq('external_id', ev.id).maybeSingle();
  if (prev?.processed_at) return ok({ received: true, duplicate: true });
  let rowId = prev?.id;
  if (!rowId) {
    const { data: ins } = await db.from('qs_events').insert({ source: 'stripe', event_type: ev.type, external_id: ev.id, payload: { object: ev.data?.object?.id, livemode: ev.livemode } }).select('id').single();
    rowId = ins?.id;
  }
  try {
    const o = ev.data.object;
    let result = 'ignored';
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') result = await checkoutCompleted(o);
    else if (ev.type === 'invoice.paid') result = await invoicePaid(o);
    else if (ev.type === 'invoice.payment_failed') result = await invoicePaid(o, true);
    else if (ev.type === 'customer.subscription.updated') result = await subscriptionChanged(o, false);
    else if (ev.type === 'customer.subscription.deleted') result = await subscriptionChanged(o, true);
    await db.from('qs_events').update({ processed_at: new Date().toISOString(), error: null, payload: { object: o?.id, livemode: ev.livemode, result } }).eq('id', rowId);
    return ok({ received: true, result });
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    await db.from('qs_events').update({ error: msg }).eq('id', rowId);
    return new Response(JSON.stringify({ error: msg }), { status: 500 }); // Stripe will retry
  }
});
