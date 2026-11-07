// companies-house-lookup
// ---------------------------------------------------------------------------
// Reusable Supabase Edge Function. Give it a UK company number, get back the
// key Companies House data in one clean JSON shape.
//
// CALL IT
//   From any page signed in to this Supabase project:
//     const { data, error } = await supabase.functions.invoke(
//       'companies-house-lookup', { body: { company_number: '16438537' } });
//   Optional body field: include_resigned (true = also return resigned officers and ceased PSCs).
//   GET also works: /functions/v1/companies-house-lookup?company_number=16438537
//
//   SEARCH BY NAME (for type-ahead):
//     supabase.functions.invoke('companies-house-lookup', { body: { search: 'accounted 4 tax' } })
//     -> { results: [{ company_number, company_name, company_status, company_type,
//                      date_of_creation, address_snippet }] }   (up to 10, min 2 characters)
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
//                  country_of_residence, date_of_birth: { month, year },
//                  address: { lines[], postcode, country, single_line } }],   // SERVICE address only
//     pscs: [{ name, kind, is_individual, natures_of_control[], control_summary[],
//              notified_on, ceased_on, nationality, country_of_residence,
//              date_of_birth: { month, year }, address: {...} }],               // SERVICE address only
//   NOTE: Companies House never publishes home addresses. Get those from the client for AML.
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

// Turn a Companies House address object into { lines[], postcode, country, single_line }.
export function formatAddress(ad: any) {
  const x = ad || {};
  const lines = [
    [x.care_of ? 'c/o ' + x.care_of : null].filter(Boolean).join(''),
    x.po_box ? 'PO Box ' + x.po_box : null,
    [x.premises, x.address_line_1].filter(Boolean).join(' '),
    x.address_line_2, x.locality, x.region,
  ].filter((v) => v && String(v).trim()) as string[];
  return {
    lines,
    postcode: x.postal_code || null,
    country: x.country || null,
    single_line: [...lines, x.postal_code].filter(Boolean).join(', '),
  };
}

// "ownership-of-shares-75-to-100-percent" -> "Ownership of shares 75 to 100 percent"
export function controlLabel(code: string) {
  const t = String(code || '').replace(/-/g, ' ').replace(/\bas trust\b/, '(as trust)').replace(/\bas firm\b/, '(as firm)');
  return t.charAt(0).toUpperCase() + t.slice(1);
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
  let search = '';
  let includeResigned = false;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    raw = u.searchParams.get('company_number') || '';
    search = u.searchParams.get('search') || '';
    includeResigned = u.searchParams.get('include_resigned') === 'true';
  } else {
    const body = await req.json().catch(() => ({}));
    raw = body.company_number || '';
    search = body.search || '';
    includeResigned = body.include_resigned === true;
  }

  // 3. Key configured?
  const key = Deno.env.get('COMPANIES_HOUSE_API_KEY');
  if (!key) return fail(503, 'not_configured', 'Companies House API key has not been added yet.');

  // 3a. Search by name
  if (!raw && search) {
    const q = String(search).trim();
    if (q.length < 2) return json({ results: [] });
    const r = await chGet(`/search/companies?q=${encodeURIComponent(q)}&items_per_page=10`, key);
    if (r.status === 429) return fail(429, 'rate_limited', 'Companies House is busy. Try again in a minute.');
    if (r.status === 401) return fail(503, 'not_configured', 'Companies House rejected the API key. Check the secret.');
    if (r.status !== 200) return fail(502, 'upstream_error', 'Companies House search did not respond properly. Try again.');
    const results = ((r.data?.items || []) as any[]).map((i) => ({
      company_number: i.company_number,
      company_name: i.title,
      company_status: i.company_status || null,
      company_type: i.company_type || null,
      date_of_creation: i.date_of_creation || null,
      address_snippet: i.address_snippet || null,
    }));
    return json({ results });
  }

  const number = normaliseCompanyNumber(raw);
  if (!number) return fail(400, 'bad_request', 'Enter a valid company number, e.g. 16438537 or SC123456, or a name to search.');

  // 4. Fetch profile + officers in parallel
  const [profile, officers, pscRes] = await Promise.all([
    chGet(`/company/${number}`, key),
    chGet(`/company/${number}/officers?items_per_page=100`, key),
    chGet(`/company/${number}/persons-with-significant-control?items_per_page=100`, key),
  ]);
  if (profile.status === 404) return fail(404, 'not_found', `No company found with number ${number}.`);
  if (profile.status === 401) return fail(503, 'not_configured', 'Companies House rejected the API key. Check the secret.');
  if (profile.status === 429) return fail(429, 'rate_limited', 'Companies House is busy. Try again in a minute.');
  if (profile.status !== 200 || !profile.data) return fail(502, 'upstream_error', 'Companies House did not respond properly. Try again.');

  const c = profile.data;
  const a = c.accounts || {};
  const ard = a.accounting_reference_date || {};
  const ro = c.registered_office_address || {};
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
      country_of_residence: o.country_of_residence || null,
      date_of_birth: o.date_of_birth ? { month: o.date_of_birth.month, year: o.date_of_birth.year } : null,
      address: formatAddress(o.address),
    }));

  const pscItems = (pscRes.data?.items || []) as any[];
  const pscList = pscItems
    .filter((p) => includeResigned || !(p.ceased_on || p.ceased))
    .filter((p) => !String(p.kind || '').includes('statement'))
    .map((p) => ({
      name: p.name || null,
      kind: p.kind || null,
      is_individual: String(p.kind || '').startsWith('individual'),
      natures_of_control: p.natures_of_control || [],
      control_summary: (p.natures_of_control || []).map(controlLabel),
      notified_on: p.notified_on || null,
      ceased_on: p.ceased_on || null,
      nationality: p.nationality || null,
      country_of_residence: p.country_of_residence || null,
      date_of_birth: p.date_of_birth ? { month: p.date_of_birth.month, year: p.date_of_birth.year } : null,
      address: formatAddress(p.address),
      registration_number: p.identification?.registration_number || null,
    }));

  return json({
    company_number: c.company_number || number,
    company_name: c.company_name || null,
    company_status: c.company_status || null,
    company_type: c.type || null,
    date_of_creation: c.date_of_creation || null,
    sic_codes: c.sic_codes || [],
    registered_office: formatAddress(ro),
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
    pscs: pscList,
    pscs_available: pscRes.status === 200 || pscRes.status === 404,
    fetched_at: new Date().toISOString(),
  });
});
