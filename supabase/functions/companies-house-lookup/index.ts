// companies-house-lookup
// ---------------------------------------------------------------------------
// Reusable Supabase Edge Function. Give it a UK company number, get back the
// key Companies House data in one clean JSON shape.
//
// CALL IT
//   From any page signed in to this Supabase project:
//     const { data, error } = await supabase.functions.invoke(
//       'companies-house-lookup', { body: { company_number: '16438537' } });
//   Optional body field: include_resigned (true = also return resigned officers).
//   GET also works: /functions/v1/companies-house-lookup?company_number=16438537
//
// WHO CAN CALL IT
//   Only signed-in users listed in public.qs_admins (checked via qs_is_admin()).
//   The Practice Manager uses the same login, so it can reuse this function.
//
// SECRET NEEDED
//   COMPANIES_HOUSE_API_KEY  (free key from developer.company-information.service.gov.uk)
//   Stored only as a Supabase Edge Function secret. Never in GitHub.
//
// RESPONSE (200)
//   {
//     company_number, company_name, company_status, company_type, date_of_creation,
//     sic_codes[], registered_office: { lines[], postcode, country, single_line },
//     accounting_reference_date: { day, month, label },        // e.g. "31 March"
//     next_accounts_period_end,    // ISO date — use as the Ltd year end for quotes
//     next_accounts_period_start, accounts_due_date, last_accounts_made_up_to,
//     confirmation_statement_due_date, confirmation_statement_made_up_to,
//     officers: [{ name, role, appointed_on, resigned_on, nationality, occupation,
//                  date_of_birth: { month, year } }],
//     fetched_at
//   }
// ERRORS: { error: { code, message } } with codes
//   bad_request (400), unauthorised (401), forbidden (403), not_found (404),
//   not_configured (503), rate_limited (429), upstream_error (502)
// ---------------------------------------------------------------------------

import { createClient } from 'npm:@supabase/supabase-js@2';

const CH_BASE = 'https://api.company-information.service.gov.uk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

// "123456" -> "00123456"; "sc 12345" -> "SC012345"
export function normaliseCompanyNumber(raw: string): string | null {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  const m = s.match(/^([A-Z]{2})?(\d{1,8})$/);
  if (!m) return null;
  const prefix = m[1] || '';
  const digits = m[2].padStart(8 - prefix.length, '0');
  const out = prefix + digits;
  return out.length === 8 ? out : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

async function chGet(path: string, key: string) {
  const res = await fetch(CH_BASE + path, {
    headers: { Authorization: 'Basic ' + btoa(key + ':'), Accept: 'application/json' },
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) return { status: res.status, data: null };
  return { status: 200, data: await res.json() };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // 1. Must be a signed-in admin
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return fail(401, 'unauthorised', 'Sign in first.');
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: isAdmin, error: adminErr } = await sb.rpc('qs_is_admin');
  if (adminErr) return fail(401, 'unauthorised', 'Could not verify your login.');
  if (!isAdmin) return fail(403, 'forbidden', 'This account is not allowed to use the lookup.');

  // 2. Read input
  let raw = '';
  let includeResigned = false;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    raw = u.searchParams.get('company_number') || '';
    includeResigned = u.searchParams.get('include_resigned') === 'true';
  } else {
    const body = await req.json().catch(() => ({}));
    raw = body.company_number || '';
    includeResigned = body.include_resigned === true;
  }
  const number = normaliseCompanyNumber(raw);
  if (!number) return fail(400, 'bad_request', 'Enter a valid company number, e.g. 16438537 or SC123456.');

  // 3. Key configured?
  const key = Deno.env.get('COMPANIES_HOUSE_API_KEY');
  if (!key) return fail(503, 'not_configured', 'Companies House API key has not been added yet.');

  // 4. Fetch profile + officers in parallel
  const [profile, officers] = await Promise.all([
    chGet(`/company/${number}`, key),
    chGet(`/company/${number}/officers?items_per_page=100`, key),
  ]);
  if (profile.status === 404) return fail(404, 'not_found', `No company found with number ${number}.`);
  if (profile.status === 401) return fail(503, 'not_configured', 'Companies House rejected the API key. Check the secret.');
  if (profile.status === 429) return fail(429, 'rate_limited', 'Companies House is busy. Try again in a minute.');
  if (profile.status !== 200 || !profile.data) return fail(502, 'upstream_error', 'Companies House did not respond properly. Try again.');

  const c = profile.data;
  const a = c.accounts || {};
  const ard = a.accounting_reference_date || {};
  const ro = c.registered_office_address || {};
  const lines = [
    [ro.premises, ro.address_line_1].filter(Boolean).join(' '),
    ro.address_line_2, ro.locality, ro.region,
  ].filter((x) => x && String(x).trim());
  const ardDay = ard.day ? Number(ard.day) : null;
  const ardMonth = ard.month ? Number(ard.month) : null;

  const officerItems = (officers.data?.items || []) as any[];
  const officerList = officerItems
    .filter((o) => includeResigned || !o.resigned_on)
    .map((o) => ({
      name: o.name,
      role: o.officer_role,
      appointed_on: o.appointed_on || null,
      resigned_on: o.resigned_on || null,
      nationality: o.nationality || null,
      occupation: o.occupation || null,
      date_of_birth: o.date_of_birth ? { month: o.date_of_birth.month, year: o.date_of_birth.year } : null,
    }));

  return json({
    company_number: c.company_number || number,
    company_name: c.company_name || null,
    company_status: c.company_status || null,
    company_type: c.type || null,
    date_of_creation: c.date_of_creation || null,
    sic_codes: c.sic_codes || [],
    registered_office: {
      lines,
      postcode: ro.postal_code || null,
      country: ro.country || null,
      single_line: [...lines, ro.postal_code].filter(Boolean).join(', '),
    },
    accounting_reference_date: {
      day: ardDay,
      month: ardMonth,
      label: ardDay && ardMonth ? `${ardDay} ${MONTHS[ardMonth - 1]}` : null,
    },
    next_accounts_period_start: a.next_accounts?.period_start_on || null,
    next_accounts_period_end: a.next_accounts?.period_end_on || a.next_made_up_to || null,
    accounts_due_date: a.next_accounts?.due_on || a.next_due || null,
    last_accounts_made_up_to: a.last_accounts?.made_up_to || null,
    confirmation_statement_due_date: c.confirmation_statement?.next_due || null,
    confirmation_statement_made_up_to: c.confirmation_statement?.next_made_up_to || null,
    officers: officerList,
    officers_available: officers.status === 200,
    fetched_at: new Date().toISOString(),
  });
});
