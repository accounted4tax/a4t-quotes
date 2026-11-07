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
//     upcoming_year_end,           // ISO date — next accounting year end on/after today. USE THIS for quotes.
//     next_accounts_period_end,    // ISO date — end of the next period to be FILED (can be in the past)
//     outstanding_accounts: [{ period_end, due_date, overdue }], // periods ended before today, not yet filed
//                                  //   -> quote these as CATCH-UP (one-off) work
//     accounts_overdue, confirmation_statement_overdue,  // booleans from Companies House
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

// Next date on/after `from` that falls on the accounting reference day/month (UTC dates).
export function upcomingYearEnd(day: number | null, month: number | null, from = new Date()): string | null {
  if (!day || !month) return null;
  const today = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (const y of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const last = new Date(Date.UTC(y, month, 0)).getUTCDate(); // handles 29 Feb
    const d = new Date(Date.UTC(y, month - 1, Math.min(day, last)));
    if (d >= today) return d.toISOString().slice(0, 10);
  }
  return null;
}

// Every accounting period that has already ended but is not yet filed, oldest first.
// Companies House only reports the first unfiled period; later ones are inferred one year apart.
// Due date for inferred periods = period end + 9 months (private company rule).
export function outstandingPeriods(firstEnd: string | null, firstDue: string | null, from = new Date()) {
  if (!firstEnd) return [];
  const today = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const out: { period_end: string; due_date: string | null; overdue: boolean }[] = [];
  const start = new Date(firstEnd + 'T00:00:00Z');
  for (let i = 0; i < 10; i++) {
    const y = start.getUTCFullYear() + i, m = start.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const end = new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), last)));
    if (end >= today) break;
    let due: string | null = i === 0 ? firstDue : null;
    if (!due) {
      const dm = m + 9, dy = y + Math.floor(dm / 12), mm = dm % 12;
      const dl = new Date(Date.UTC(dy, mm + 1, 0)).getUTCDate();
      due = new Date(Date.UTC(dy, mm, Math.min(end.getUTCDate(), dl))).toISOString().slice(0, 10);
    }
    out.push({ period_end: end.toISOString().slice(0, 10), due_date: due, overdue: !!due && new Date(due + 'T00:00:00Z') < today });
  }
  return out;
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
    upcoming_year_end: upcomingYearEnd(ardDay, ardMonth),
    next_accounts_period_start: a.next_accounts?.period_start_on || null,
    next_accounts_period_end: a.next_accounts?.period_end_on || a.next_made_up_to || null,
    accounts_due_date: a.next_accounts?.due_on || a.next_due || null,
    outstanding_accounts: outstandingPeriods(
      a.next_accounts?.period_end_on || a.next_made_up_to || null,
      a.next_accounts?.due_on || a.next_due || null),
    accounts_overdue: !!(a.next_accounts?.overdue || a.overdue),
    confirmation_statement_overdue: !!c.confirmation_statement?.overdue,
    last_accounts_made_up_to: a.last_accounts?.made_up_to || null,
    confirmation_statement_due_date: c.confirmation_statement?.next_due || null,
    confirmation_statement_made_up_to: c.confirmation_statement?.next_made_up_to || null,
    officers: officerList,
    officers_available: officers.status === 200,
    fetched_at: new Date().toISOString(),
  });
});
