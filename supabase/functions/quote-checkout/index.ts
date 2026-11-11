// quote-checkout — PUBLIC (no login), used by sign.html / paid.html / portal.html with the secret quote link token.
//   { action: 'create', token }  → Stripe Checkout for an ACCEPTED quote, returns { url } (or { paid: true }).
//        Pay in full → one payment (mode=payment) with a Stripe invoice. Pay monthly → subscription (mode=subscription);
//        catch-up / Self Assessment deposit / one-off items go on the first invoice together with the first monthly payment.
//        Monthly plans that run until cancelled are extra recurring items under either option.
//        The webhook (stripe-webhook) then limits the monthly fee to the quoted number of payments (subscription schedule).
//   { action: 'status', token }  → { paid, status } for the confirmation page.
//   { action: 'portal', token }  → Stripe Customer Portal link (update card, invoices, cancel) for a paid client.
// Phase 6, 11 Nov 2026. Secrets: STRIPE_SECRET_KEY.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { stripe, pence, stripeLive } from './stripe.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (s: number, code: string, message: string) => json({ error: { code, message } }, s);
const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fd = (d?: string | null) => !d ? '' : new Date(String(d).length === 10 ? d + 'T12:00:00Z' : String(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const gbp = (n: number) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const FOOTER = 'Accounted4Tax Ltd is not VAT registered, so no VAT is charged. Registered in England and Wales, company number 16438537. Registered office 128 City Road, London EC1V 2NX.';

async function load(token: string) {
  const { data: q } = await db.from('qs_quotes').select('*, client:clients(*)').eq('access_token', token).maybeSingle();
  if (!q) return null;
  const { data: lines } = await db.from('qs_quote_lines').select('*').eq('quote_id', q.id).order('sort_order');
  const { data: st } = await db.from('qs_settings').select('key,value').in('key', ['app_base_url']);
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  return { q, c: q.client, lines: lines || [], base: String(S.app_base_url || 'https://accounted4tax.github.io/a4t-quotes').replace(/\/$/, '') };
}

// One Stripe customer per client; recreated if the saved one is from the other mode (sandbox vs live) or was deleted.
async function ensureCustomer(c: any, display: string) {
  if (c.stripe_customer_id) {
    try { const cu = await stripe('GET', `customers/${c.stripe_customer_id}`); if (!cu.deleted) return cu.id; } catch (_) { /* create a new one */ }
  }
  const cu = await stripe('POST', 'customers', {
    email: c.email, name: display, phone: c.phone || undefined,
    metadata: { client_id: c.id, client_type: c.client_type, source: 'a4t-quotes' },
    invoice_settings: { footer: FOOTER },
    preferred_locales: ['en-GB'],
  }, `cust-${c.id}-${stripeLive() ? 'live' : 'test'}`);
  await db.from('clients').update({ stripe_customer_id: cu.id }).eq('id', c.id);
  return cu.id;
}

const label = (l: any) => `${l.description}${l.is_earlier_year ? ' catch-up' : ''}${l.period_label ? ` (${l.period_label})` : ''}`.slice(0, 250);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const body = await req.json().catch(() => ({}));
  const token = String(body.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return fail(404, 'not_found', 'This quote link is not valid.');
  const L = await load(token);
  if (!L) return fail(404, 'not_found', 'This quote link is not valid.');
  const { q, c, lines, base } = L;
  const action = body.action || 'create';
  const display = c.client_type === 'ltd' ? (c.company_name || c.full_name) : (c.trading_name ? `${c.full_name} (${c.trading_name})` : c.full_name);

  try {
    // ---------- status (confirmation page) ----------
    if (action === 'status') {
      if (q.status === 'paid') return json({ paid: true, status: 'paid', quote_number: q.quote_number, portal: !!c.stripe_customer_id });
      if (q.stripe_checkout_session_id) {
        const s = await stripe('GET', `checkout/sessions/${q.stripe_checkout_session_id}`);
        const paid = s.status === 'complete' && ['paid', 'no_payment_required'].includes(s.payment_status);
        return json({ paid, status: paid ? 'processing' : q.status, quote_number: q.quote_number, portal: paid });
      }
      return json({ paid: false, status: q.status, quote_number: q.quote_number });
    }

    // ---------- customer portal ----------
    if (action === 'portal') {
      if (!c.stripe_customer_id || !['paid'].includes(q.status)) return fail(409, 'not_paid', 'Your payment account is set up once your first payment has gone through.');
      const ps = await stripe('POST', 'billing_portal/sessions', { customer: c.stripe_customer_id, return_url: `${base}/paid.html?t=${token}`, locale: 'en-GB' });
      return json({ url: ps.url });
    }

    if (action !== 'create') return fail(400, 'bad_request', 'Unknown action.');
    if (q.status === 'paid') return json({ paid: true });
    if (q.status !== 'accepted') return fail(409, 'not_accepted', 'Please accept and sign the quote first.');

    // reuse an open Checkout page if the client comes back
    if (q.stripe_checkout_session_id) {
      try {
        const s = await stripe('GET', `checkout/sessions/${q.stripe_checkout_session_id}`);
        if (s.status === 'open' && s.url) return json({ url: s.url });
        if (s.status === 'complete') return json({ paid: true });
      } catch (_) { /* make a new one */ }
    }

    const monthly = !!q.monthly_allowed && q.payment_option === 'monthly';
    const n = monthly ? Number(q.payments_count) : 0;
    const meta = { quote_id: q.id, quote_number: q.quote_number, quote_version: String(q.version), client_id: c.id, payment_option: monthly ? 'monthly' : 'one_off', payments_count: String(n || '') };
    const items: any[] = [];
    const oneTime = (name: string, amount: number, description?: string) => {
      if (pence(amount) <= 0) return;
      items.push({ quantity: 1, price_data: { currency: 'gbp', unit_amount: pence(amount), product_data: { name, description: description?.slice(0, 500) || undefined, metadata: { kind: 'one_off' } } } });
    };
    const recurring = (name: string, amount: number, kind: 'fixed' | 'rolling', description?: string) => {
      if (pence(amount) <= 0) return;
      items.push({ quantity: 1, price_data: { currency: 'gbp', unit_amount: pence(amount), recurring: { interval: 'month', interval_count: 1 },
        product_data: { name, description: description?.slice(0, 500) || undefined, metadata: { kind, quote_id: q.id } } } });
    };

    let ongoingNames: string[] = [];
    for (const l of lines) {
      const total = Number(l.line_total || 0);
      if (l.runs_until_cancelled) recurring(`${l.description} – monthly plan`, total, 'rolling', 'Charged monthly until you cancel (14 days\' notice before the next payment).');
      else if (l.charge_kind === 'deposit_balance') oneTime(`${label(l)} – deposit`, Number(l.deposit_amount || 0), Number(l.balance_amount) ? `The balance of ${gbp(Number(l.balance_amount))} is taken before we submit your return to HMRC.` : undefined);
      else if (l.charge_kind === 'ongoing') { if (monthly) ongoingNames.push(label(l)); else oneTime(label(l), total); }
      else oneTime(label(l), total);
    }
    if (monthly) recurring(`Monthly fee – ${n} payments`, Number(q.monthly_amount), 'fixed', `Quote ${q.quote_number}: ${ongoingNames.join('; ')}. ${n} monthly payments, ${fd(q.first_payment_date)} to ${fd(q.last_payment_date)}.`);
    ongoingNames = [];

    // safety check: what Checkout charges today must equal what the client saw and signed for
    const R = Number(q.rolling_monthly || 0);
    const expected = r2(Number(q.one_off_due_now) + (monthly ? Number(q.monthly_amount) : Number(q.ongoing_total)) + R);
    const charged = r2(items.reduce((a, it) => a + it.price_data.unit_amount, 0) / 100);
    if (Math.abs(expected - charged) > 0.009) throw new Error(`amount_mismatch expected ${expected} got ${charged}`);
    if (!items.length) throw new Error('nothing_to_charge');

    const customer = await ensureCustomer(c, display);
    const isSub = items.some((it) => it.price_data.recurring);
    const params: any = {
      mode: isSub ? 'subscription' : 'payment', customer, line_items: items, client_reference_id: q.id, metadata: meta, locale: 'en-GB',
      billing_address_collection: 'auto', customer_update: { address: 'auto', name: 'auto' },
      success_url: `${base}/paid.html?t=${token}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/sign.html?t=${token}&payment=cancelled`,
      custom_text: { submit: { message: `Quote ${q.quote_number}. Accounted4Tax Ltd is not VAT registered.` } },
    };
    if (isSub) {
      params.subscription_data = { description: `Accounted4Tax – quote ${q.quote_number}`, metadata: meta };
    } else {
      params.invoice_creation = { enabled: true, invoice_data: { description: `Accounted4Tax – quote ${q.quote_number}`, metadata: meta, footer: FOOTER } };
      params.payment_intent_data = { description: `Accounted4Tax – quote ${q.quote_number}`, metadata: meta,
        // keep the card for the Self Assessment balance, taken before we submit the return
        setup_future_usage: Number(q.balance_later) > 0 ? 'off_session' : undefined };
    }
    const s = await stripe('POST', 'checkout/sessions', params);
    await db.from('qs_quotes').update({ stripe_checkout_session_id: s.id }).eq('id', q.id);
    await db.from('qs_events').insert({ source: 'client', event_type: 'checkout_created', client_id: c.id, quote_id: q.id,
      payload: { session: s.id, mode: params.mode, due_now: charged, live: stripeLive() } });
    return json({ url: s.url });
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    await db.from('qs_events').insert({ source: 'system', event_type: 'checkout_error', client_id: c.id, quote_id: q.id, payload: { action, error: msg } });
    return fail(500, 'server', 'We could not open the payment page. Please try again in a minute, or reply to our email.');
  }
});
