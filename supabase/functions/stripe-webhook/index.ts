// stripe-webhook — Stripe calls this after payments. PUBLIC URL, but every call is checked with the webhook signing
// secret (STRIPE_WEBHOOK_SECRET); anything not signed by Stripe is rejected. Each event is handled once (qs_events.external_id).
//   checkout.session.completed      → quote paid; Stripe customer/payment/subscription saved; monthly fee limited to the quoted
//                                     number of payments with a subscription schedule (plans until cancelled carry on after).
//   invoice.paid                    → invoice saved (number, amount, PDF link); monthly payments counted; overdue flag cleared.
//   invoice.payment_failed          → subscription flagged "payment overdue"; Eduard emailed (Stripe retries automatically).
//   customer.subscription.updated   → client asked to cancel (portal) → Eduard emailed.
//   customer.subscription.deleted   → subscription "completed" (all payments made) or "cancelled" (Eduard emailed).
// Phase 6, 11 Nov 2026. Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BREVO_API_KEY.
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
