// loe — assembles the engagement letter for one quote from the approved templates (version 1, approved 11 Nov 2026).
// The client sees exactly this text on the signing page, and the same text goes into the signed PDF.
//   Part A covering letter · Part B standard terms · Part C privacy notice · Part D only the schedules for the quoted
//   services · Part E cancellation form (consumers only). Placeholders {{...}} come from the quote and client record.
//   Conditions: [IF x] ... [END] inline, a line starting with [IF x] (line kept only if x), or a line that is only
//   [IF x] up to [END ...] (block). MTD plan markers [All plans] / [Essential] / [Compliance / Full MTD] / [Full MTD].
// deno-lint-ignore-file no-explicit-any

export type Templates = { version: number; part_a: string; acceptance: string; part_b: string; part_c: string; part_e: string;
  schedule_open: string; schedule_close: string; schedules: Record<string, { title: string; body: string }> };

export const ONLINE_SCHEDULES = ['D10'];

const D9_ROWS: Record<string, string> = {
  sa_reg: 'Self Assessment registration', vat_reg: 'VAT registration', paye_reg: 'PAYE', pension_setup: 'Workplace pension',
  mtd_signup: 'MTD for Income Tax sign-up', mtd_oneoff: 'One-off MTD', p87: 'Employment expenses', catch_up: 'Catch-up work',
};

const fmtDate = (d?: string | null) => !d ? '' : new Date(String(d).length === 10 ? d + 'T12:00:00Z' : String(d))
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const gbp = (n: number) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- conditions ----------
const FLAG_KEY = (s: string) => s.trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
export function applyConditions(text: string, flags: Record<string, boolean>, plan: string | null) {
  // [IF not x] is the opposite of [IF x]
  const on = (name: string) => { const k = FLAG_KEY(name); return k.startsWith('not_') ? !flags[k.slice(4)] : !!flags[k]; };
  const lines = text.split('\n'), out: string[] = [];
  let skipping: boolean | null = null;
  for (let line of lines) {
    const t = line.trim();
    const blockStart = t.match(/^`?\[IF ([^\]]+)\]`?$/);
    const blockEnd = /^`?\[END[^\]]*\]`?$/.test(t);
    if (blockStart) { skipping = !on(blockStart[1]); continue; }
    if (blockEnd && skipping !== null) { skipping = null; continue; }
    if (skipping) continue;
    // inline [IF x] ... [END]
    line = line.replace(/`?\[IF ([^\]]+)\]`?\s?(.*?)\s?`?\[END[^\]]*\]`?/g, (_m, f, body) => on(f) ? body : '');
    // a line that still carries [IF x] is kept only when x applies
    const lineIf = line.match(/`?\[IF ([^\]]+)\]`?\s?/);
    if (lineIf) { if (!on(lineIf[1])) continue; line = line.replace(lineIf[0], ''); }
    // MTD plan markers
    const pm = line.match(/`?\[(All plans|Essential|Compliance \/ Full MTD|Full MTD)\]`?\s?/);
    if (pm) {
      const ok = pm[1] === 'All plans' ? !!plan : pm[1] === 'Essential' ? plan === 'essential'
        : pm[1] === 'Full MTD' ? plan === 'full' : (plan === 'compliance' || plan === 'full');
      if (!ok) continue;
      line = line.replace(pm[0], '');
    }
    out.push(line.replace(/\s{2,}/g, ' ').replace(/ ([.,;])/g, '$1'));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function fill(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// D9 table: keep the header and only the rows for the services on the quote
function filterD9(body: string, tags: Set<string>) {
  return body.split('\n').filter((l) => {
    if (!l.startsWith('|') || /^\|\s*Service\s*\|/.test(l) || /^\|[-| ]+\|$/.test(l)) return true;
    const first = l.split('|')[1]?.trim() || '';
    return [...tags].some((t) => D9_ROWS[t] && first.startsWith(D9_ROWS[t]));
  }).join('\n');
}

// ---------- assemble ----------
export function assembleLoe(T: Templates, d: {
  quote: any; client: any; lines: any[]; services: Record<string, any>; practice: any; payment_option: 'one_off' | 'monthly' | null;
}) {
  const { quote: q, client: c, lines } = d;
  const ltd = c.client_type === 'ltd';
  const names = lines.map((l) => String(l.description || ''));
  const has = (re: RegExp) => names.some((n) => re.test(n));
  // schedules from the services' keys
  const keys = new Set<string>(), d9 = new Set<string>();
  for (const l of lines) {
    const s = d.services[l.service_id] || {};
    String(s.loe_schedule_key || '').split(',').map((x: string) => x.trim()).filter(Boolean).forEach((k: string) => {
      if (k.startsWith('D9:')) { keys.add('D9'); d9.add(k.slice(3)); } else keys.add(k);
    });
    if (l.is_earlier_year) { keys.add('D9'); d9.add('catch_up'); }
  }
  const order = Object.keys(T.schedules);
  const scheds = order.filter((k) => keys.has(k));
  const plan = has(/Full MTD/i) ? 'full' : has(/MTD for Income Tax — Compliance/i) ? 'compliance' : has(/MTD for Income Tax — Essential/i) ? 'essential' : null;
  const flags: Record<string, boolean> = {
    ltd, consumer: !ltd, individual: !ltd, business_client: ltd, alternate: false, included: false,
    // simple one-off services bought online on the website (schedule D10, CIS registration): short letter, no quote, no ID check
    online: scheds.length > 0 && scheds.every((k) => ONLINE_SCHEDULES.includes(k)),
    dormant: has(/dormant/i), director_id_verification: has(/Director ID/i), auto_enrolment: has(/Pension run/i), payroll: keys.has('D7'),
  };

  // placeholders
  const ye = q.year_end_date;
  const y = ye ? Number(String(ye).slice(0, 4)) : null;
  const firstPeriod = !ye ? 'the period in your quote' : ltd ? `the accounting period ending ${fmtDate(ye)}` : `the tax year ${y! - 1}/${String(y).slice(-2)} (6 April ${y! - 1} to 5 April ${y})`;
  const servicesList = lines.map((l) => `- ${l.description}${l.period_label ? ` (${l.period_label})` : ''}`).join('\n');
  const schedulesList = scheds.length ? 'Schedule' + (scheds.length > 1 ? 's ' : ' ') + scheds.map((k) => `${k} (${T.schedules[k].title.replace(/\s*\(.*\)$/, '')})`).join(', ') : 'Schedules of services';
  const vars: Record<string, string> = {
    letter_date: fmtDate(q.sent_at || q.created_at), quote_number: q.quote_number, quote_version: String(q.version || 1),
    client_name: c.full_name || '', client_first_name: String(c.full_name || '').trim().split(/\s+/)[0] || '',
    business_name: ltd ? (c.company_name || '') : (c.trading_name || ''), client_address: c.address || '',
    company_name: c.company_name || '', company_number: c.crn || '', nominated_person: c.full_name || '',
    start_date: fmtDate(q.start_date || q.created_at), first_period: firstPeriod, year_end: ye ? fmtDate(ye) : 'your year end',
    services_list: servicesList, total: gbp(Number(q.total || 0)), schedules_list: schedulesList, payroll_frequency: 'monthly',
  };
  const prep = (s: string) => fill(applyConditions(s, flags, plan), vars);

  const parts: { key: string; title: string; md: string }[] = [];
  parts.push({ key: 'A', title: 'Engagement letter', md: prep(T.part_a.replace('{{client_name}} {{business_name}} {{client_address}}', '{{client_name}}\n{{business_name}}\n{{client_address}}')) });
  parts.push({ key: 'B', title: 'Standard terms and conditions of business', md: prep(T.part_b) });
  parts.push({ key: 'C', title: 'Privacy notice', md: prep(T.part_c) });
  for (const k of scheds) {
    let body = T.schedules[k].body;
    if (k === 'D9') body = filterD9(body, d9);
    parts.push({ key: k, title: `Schedule ${k} — ${T.schedules[k].title}`, md: prep(`${T.schedule_open}\n\n${body}\n\n${T.schedule_close}`) });
  }
  if (!ltd) parts.push({ key: 'E', title: 'Cancellation form', md: prep(T.part_e) });

  // acceptance tick boxes (shown on the signing screen and recorded in the PDF)
  const accLines = prep(T.acceptance).split('\n');
  const intro = accLines.filter((l) => l.trim() && !l.startsWith('- [') && !/^Full name/.test(l)).join(' ');
  const items = accLines.filter((l) => l.startsWith('- [')).map((l) => {
    const text = l.replace(/^- \[[ x]\]\s*/, '').replace(/\s*\*\((required|optional[^)]*)\)\*\s*$/i, '').trim();
    const required = /\*\(required\)\*/.test(l);
    const key = /start work before/i.test(text) ? 'start_now' : /email me about other services/i.test(text) ? 'marketing' : /privacy notice/i.test(text) ? 'privacy' : 'accept';
    return { key, text, required, note: key === 'start_now' ? 'Optional. If you leave this unticked, we start work after the 14 days.' : key === 'marketing' ? 'Optional.' : '' };
  });

  // payment wording for emails and the record
  const R = Number(q.rolling_monthly || 0);
  let pay = '';
  if (d.payment_option === 'monthly' && q.monthly_allowed) pay = `${gbp(Number(q.one_off_due_now) + Number(q.monthly_amount) + R)} on acceptance, then ${q.payments_count - 1} monthly payments of ${gbp(Number(q.monthly_amount) + R)}${R ? `, then ${gbp(R)} a month until you cancel` : ''}`;
  else pay = `${gbp(Number(q.one_off_due_now) + Number(q.ongoing_total) + R)} on acceptance${R ? `, then ${gbp(R)} a month until you cancel` : ''}`;
  if (Number(q.balance_later)) pay += `, plus ${gbp(Number(q.balance_later))} before we submit your tax return`;

  const text = parts.map((p) => `## ${p.title}\n\n${p.md}`).join('\n\n') + '\n\n## Acceptance\n\n' + intro + '\n' + items.map((i) => '- ' + i.text).join('\n');
  return { parts, intro, items, schedules: scheds, consumer: !ltd, plan, online: flags.online, payment_summary: pay, text, template_version: T.version };
}

export async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
