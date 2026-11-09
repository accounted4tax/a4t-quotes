// quote-public — PUBLIC (no login). The client's quote page calls this with the secret link token.
// Body: { token, preview? }. Returns only what the client needs to see. Marks the quote "viewed"
// the first time the client opens it, and "expired" once past its expiry date.
// preview=true (used by the admin "Preview" button) does not mark the quote viewed and can show drafts.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (s: number, code: string, message: string) => json({ error: { code, message } }, s);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const { token, preview } = await req.json().catch(() => ({}));
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return fail(404, 'not_found', 'This quote link is not valid.');
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { data: q } = await db.from('qs_quotes').select('*, client:clients(full_name,company_name,trading_name,client_type,crn)').eq('access_token', token).maybeSingle();
  if (!q) return fail(404, 'not_found', 'This quote link is not valid.');
  if (q.status === 'draft' && !preview) return fail(409, 'being_updated', 'This quote is being updated. We will email you when it is ready.');

  const now = new Date();
  let status = q.status;
  if (['sent', 'viewed'].includes(status) && q.expires_at && new Date(q.expires_at) < now) {
    status = 'expired';
    await db.from('qs_quotes').update({ status }).eq('id', q.id);
    await db.from('qs_events').insert({ source: 'system', event_type: 'quote_expired', client_id: q.client_id, quote_id: q.id });
  } else if (status === 'sent' && !preview) {
    status = 'viewed';
    await db.from('qs_quotes').update({ status, first_viewed_at: now.toISOString() }).eq('id', q.id);
    await db.from('qs_events').insert({ source: 'client', event_type: 'quote_viewed', client_id: q.client_id, quote_id: q.id, payload: { ua: req.headers.get('user-agent') } });
  }

  const [{ data: lines }, { data: st }] = await Promise.all([
    db.from('qs_quote_lines').select('description,period_label,quantity,unit_label,unit_price,months,is_earlier_year,price_period,charge_kind,gross_amount,discount_amount,line_total,deposit_amount,balance_amount,pricing_type,service_id,sort_order,runs_until_cancelled').eq('quote_id', q.id).order('sort_order'),
    db.from('qs_settings').select('key,value').in('key', ['practice', 'stripe_mode']),
  ]);
  const S = Object.fromEntries((st || []).map((x: any) => [x.key, x.value]));
  const ids = (lines || []).map((l: any) => l.service_id).filter(Boolean);
  const { data: svc } = ids.length ? await db.from('services_catalogue').select('id,description').in('id', ids) : { data: [] };
  const descr = Object.fromEntries((svc || []).map((s: any) => [s.id, s.description]));

  const p = S.practice || {};
  return json({
    practice: { name: p.name, crn: p.crn, registered_office: p.registered_office, email: p.email, phone: p.phone, website: p.website, tagline: p.tagline },
    stripe_mode: S.stripe_mode || 'test',
    preview: !!preview,
    quote: {
      quote_number: q.quote_number, status, version: q.version, created_at: q.created_at, sent_at: q.sent_at, expires_at: q.expires_at,
      start_date: q.start_date, year_end_date: q.year_end_date, tax_year: q.tax_year,
      subtotal: q.subtotal, discount_total: q.discount_total, discount_reason: q.discount_reason, total: q.total,
      one_off_total: q.one_off_total, one_off_due_now: q.one_off_due_now, ongoing_total: q.ongoing_total, balance_later: q.balance_later,
      monthly_allowed: q.monthly_allowed, monthly_amount: q.monthly_amount, rolling_monthly: q.rolling_monthly, payments_count: q.payments_count,
      first_payment_date: q.first_payment_date, last_payment_date: q.last_payment_date, late_start: q.late_start,
      message_to_client: q.message_to_client, payment_option: q.payment_option,
    },
    client: { name: q.client.client_type === 'ltd' ? q.client.company_name : (q.client.trading_name || q.client.full_name), contact: q.client.full_name, client_type: q.client.client_type, company_name: q.client.company_name, trading_name: q.client.trading_name, crn: q.client.crn },
    lines: (lines || []).map((l: any) => ({
      description: l.description, about: descr[l.service_id] || null, period_label: l.period_label,
      quantity: l.quantity, unit_label: l.unit_label, unit_price: l.unit_price, is_earlier_year: l.is_earlier_year, pricing_type: l.pricing_type, months: l.months, price_period: l.price_period,
      kind: l.charge_kind, gross: l.gross_amount, discount: l.discount_amount, total: l.line_total, deposit: l.deposit_amount, balance: l.balance_amount, rolling: !!l.runs_until_cancelled,
    })),
  });
});
