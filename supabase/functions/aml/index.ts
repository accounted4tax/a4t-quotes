// aml — identity checks (CDD) for clients, directors and PSCs. One request = one person, with a secret upload link.
// PUBLIC (upload link token, used by id.html):
//   { action: 'get', token }                                  → who, what to upload, the document lists and date rules
//   { action: 'upload_url', token, doc_type, mime, size }     → signed upload URL in the private bucket qs-aml-docs
//   { action: 'submit', token, id_kind, poa_kind, poa_date, files:[{doc_type, path, file_name, mime, size}] }
//        → checks the rules (proof of address dated within its limit, not the same document twice),
//          saves the documents (also to the Practice Manager documents table) and emails Eduard.
// ADMIN (signed in, used by the Practice Manager client page):
//   { action: 'people', client_id }                           → contact + directors + PSCs (Companies House) with their status
//   { action: 'request', client_id, person_name, person_role, email } → creates (or re-sends) the upload link email
//   { action: 'docs', request_id }                            → the uploaded files (10-minute view links)
//   { action: 'review', request_id, items:{photo_id:{ok,reason}, selfie:{…}, proof_of_address:{…}}, pep_check, sanctions_check, risk_rating, notes }
//        → all ticked: CDD verified (Practice Manager aml_records row); any crossed: a new link asking ONLY for those, with each reason
// INTERNAL (stripe-webhook, service key): { action: 'auto', quote_id } → first request for the client's contact person
// Phase 7, 11 Nov 2026. Rules follow the GOV.UK proof of identity checklist (Bona Vacantia), adopted as practice policy.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'qs-aml-docs';
const URL_ = Deno.env.get('SUPABASE_URL')!, SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (s: number, code: string, message: string) => json({ error: { code, message } }, s);
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
const fdate = (d?: string | Date | null) => !d ? '' : new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- the rules ----------
export const ID_KINDS = [
  { k: 'passport', l: 'Current signed passport' },
  { k: 'driving_licence', l: 'Current UK or EEA photocard driving licence (full, not provisional)' },
  { k: 'national_id', l: 'National identity card with photo (including EEA identity cards)' },
  { k: 'cis4', l: 'Photographic CIS4 registration card' },
  { k: 'firearms', l: 'Firearms or shotgun certificate' },
  { k: 'residence_permit', l: 'Home Office residence permit (please also upload your passport)' },
];
export const POA_KINDS = [
  { k: 'bank', l: 'Bank, building society or credit union statement or passbook', rule: 'm3' },
  { k: 'utility', l: 'Utility bill – gas, electricity, satellite TV or landline', rule: 'm3' },
  { k: 'council_tax', l: 'Council tax bill', rule: 'ct_year' },
  { k: 'mortgage', l: 'Mortgage statement from a recognised lender', rule: 'm13' },
  { k: 'solicitor', l: "Solicitor's letter confirming a recent house purchase, or Land Registry confirmation", rule: 'm3' },
  { k: 'tenancy', l: 'Council or housing association rent card, or tenancy agreement', rule: 'm12' },
  { k: 'hmrc', l: 'HMRC Self Assessment letter or tax demand', rule: 'tax_year' },
  { k: 'benefits', l: 'Benefits letter (original notification)', rule: 'none' },
  { k: 'nhs', l: 'Electoral register entry, NHS medical card or letter from your GP practice confirming registration', rule: 'none' },
  { k: 'driving_licence', l: 'Current full UK driving licence (only if you did not use it as your photo ID)', rule: 'none' },
];
const RULE_TEXT: Record<string, string> = { m3: 'dated within the last 3 months', m12: 'for the current year (dated within the last 12 months)', m13: 'your most recent annual statement',
  ct_year: 'for the current council tax year (from 1 April)', tax_year: 'dated in the current tax year (from 6 April)', none: '' };
const NOT_ACCEPTED = ['Mobile phone bills', 'Credit card statements', 'Provisional driving licences', 'PO box addresses', 'The same document for both photo ID and proof of address'];

function earliest(rule: string): Date | null {
  const t = today(), y = t.getUTCFullYear();
  const back = (m: number) => { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() - m); return d; };
  if (rule === 'm3') return back(3);
  if (rule === 'm12') return back(12);
  if (rule === 'm13') return back(13);
  if (rule === 'ct_year') { const a = new Date(Date.UTC(y, 3, 1)); return t >= a ? a : new Date(Date.UTC(y - 1, 3, 1)); }
  if (rule === 'tax_year') { const a = new Date(Date.UTC(y, 3, 6)); return t >= a ? a : new Date(Date.UTC(y - 1, 3, 6)); }
  return null;
}
const MAX_FILES: Record<string, number> = { photo_id: 3, selfie: 1, proof_of_address: 4 };
const MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'];
const roleLabel = (r?: string | null) => ({ individual: 'client', director: 'director', psc: 'person with significant control', director_psc: 'director and person with significant control' } as any)[r || ''] || 'contact';

// ---------- helpers ----------
const displayOf = (c: any) => c.client_type === 'ltd' ? (c.company_name || c.full_name) : (c.trading_name ? `${c.full_name} (${c.trading_name})` : c.full_name);
async function settings(keys: string[]) {
  const { data } = await db.from('qs_settings').select('key,value').in('key', keys);
  return Object.fromEntries((data || []).map((x: any) => [x.key, x.value]));
}
// "HUSARU, Eduard" → "Eduard Husaru"; "Mr Eduard Husaru" → "Eduard Husaru"
function niceName(n: string) {
  let s = String(n || '').trim();
  if (s.includes(',')) { const [last, first] = s.split(',').map((x) => x.trim()); s = `${first} ${last}`; }
  s = s.replace(/^(mr|mrs|ms|miss|dr|sir|dame|lady|lord)\.?\s+/i, '');
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ').trim();
}
const nameKey = (n: string) => niceName(n).toLowerCase().replace(/[^a-z]/g, '');

async function sendEmail(templateKey: string, to: { email: string; name?: string }, vars: Record<string, string>, ids: { client_id: string; quote_id?: string | null }) {
  const key = Deno.env.get('BREVO_API_KEY'); if (!key || !to.email) return { ok: false, error: 'no_key_or_email' };
  const { data: t } = await db.from('qs_email_templates').select('*').eq('template_key', templateKey).eq('is_active', true).maybeSingle();
  if (!t) return { ok: false, error: 'no_template' };
  const S = await settings(['email_sender', 'practice']);
  const p = S.practice || {}, sender = S.email_sender || { name: 'Accounted4Tax', email: 'info@accounted4tax.co.uk' };
  const subject = fill(t.subject, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')])));
  const html = `<div style="background:#F5F6F8;padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#14213D;max-width:560px;margin:0 auto;font-size:15px;line-height:1.55"><div style="background:#14213D;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">Accounted4Tax</div><div style="background:#fff;padding:22px 18px;border-radius:0 0 10px 10px">${fill(t.body_html, vars)}</div><p style="color:#4A5568;font-size:12px;text-align:center;margin-top:14px">${esc(p.name || 'Accounted4Tax Ltd')} · ${esc(p.registered_office || '128 City Road, London EC1V 2NX')} · ${esc(p.email || 'info@accounted4tax.co.uk')}${p.phone ? ' · ' + esc(p.phone) : ''}</p></div></div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, replyTo: sender, to: [to], subject, htmlContent: html, tags: [templateKey] }) });
  const out = await res.json().catch(() => ({}));
  await db.from('qs_email_log').insert({ client_id: ids.client_id, quote_id: ids.quote_id || null, template_key: templateKey, to_email: to.email, subject,
    status: res.ok ? 'sent' : 'failed', brevo_message_id: out.messageId || null, error: res.ok ? null : (out.message || `HTTP ${res.status}`) });
  return { ok: res.ok, error: res.ok ? null : (out.message || `HTTP ${res.status}`) };
}

// overall client status = the "least done" of the people asked
async function refreshClientStatus(client_id: string) {
  const { data: rs } = await db.from('qs_aml_requests').select('person_name,status,created_at').eq('client_id', client_id).neq('status', 'cancelled').order('created_at', { ascending: false });
  const latest = new Map<string, string>();
  for (const r of rs || []) { const k = nameKey(r.person_name || ''); if (!latest.has(k)) latest.set(k, r.status); }
  const st = [...latest.values()];
  const status = !st.length ? 'not_requested' : st.every((s) => s === 'verified') ? 'verified' : st.some((s) => s === 'requested' || s === 'rejected') ? 'requested' : 'received';
  await db.from('clients').update({ aml_status: status }).eq('id', client_id);
  return status;
}

const ITEMS = ['photo_id', 'selfie', 'proof_of_address'];
const ITEM_LABEL: Record<string, string> = { photo_id: 'Photo ID', selfie: 'Selfie holding your ID', proof_of_address: 'Proof of address' };
const NEED_TEXT: Record<string, string> = {
  photo_id: '<b>Photo ID</b> – a current passport, photocard driving licence (full, not provisional), national identity card, photographic CIS4 card or firearms/shotgun certificate.',
  selfie: '<b>A selfie</b> – a clear photo of your face holding that same ID next to it.',
  proof_of_address: "<b>Proof of address</b> in your name – for example a bank statement or utility bill dated within the last 3 months, or this year's council tax bill. Mobile phone bills and credit card statements are not accepted.",
};

async function createRequest(c: any, person: { name: string; role: string; email: string },
  opts: { quote_id?: string | null; by?: string; needs?: string[]; item_reasons?: Record<string, string>; parent_request_id?: string }) {
  const needs = (opts.needs && opts.needs.length ? opts.needs : ITEMS).filter((x) => ITEMS.includes(x));
  const S = await settings(['app_base_url', 'practice']);
  const base = String(S.app_base_url || 'https://accounted4tax.github.io/a4t-quotes').replace(/\/$/, '');
  const name = niceName(person.name);
  // re-use an open link for the same person, otherwise a new one
  const { data: open } = await db.from('qs_aml_requests').select('*').eq('client_id', c.id).eq('status', 'requested').order('created_at', { ascending: false });
  let req = (open || []).find((r: any) => nameKey(r.person_name || '') === nameKey(name));
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  if (req && !opts.parent_request_id) {
    const { data } = await db.from('qs_aml_requests').update({ person_email: person.email, person_role: person.role, token_expires_at: expires, requested_at: new Date().toISOString() }).eq('id', req.id).select('*').single();
    req = data;
  } else {
    const { data, error } = await db.from('qs_aml_requests').insert({ client_id: c.id, quote_id: opts.quote_id || null, person_name: name, person_role: person.role, person_email: person.email,
      upload_token: newToken(), status: 'requested', requested_at: new Date().toISOString(), token_expires_at: expires,
      needs, item_reasons: opts.item_reasons || null, parent_request_id: opts.parent_request_id || null,
      notes: opts.item_reasons ? 'Asked again: ' + Object.entries(opts.item_reasons).map(([k, v]) => `${ITEM_LABEL[k]} – ${v}`).join('; ') : null }).select('*').single();
    if (error) throw new Error('request: ' + error.message);
    req = data;
  }
  const ltd = c.client_type === 'ltd', isContact = nameKey(name) === nameKey(c.full_name || '');
  const company = esc(c.company_name || '');
  const again = opts.item_reasons && Object.keys(opts.item_reasons).length;
  const reason = again
    ? `Thank you for sending your documents. Unfortunately we could not accept ${Object.keys(opts.item_reasons!).length === 1 ? 'one of them' : 'some of them'}:</p><ul style="padding-left:20px;margin:0 0 12px">${Object.entries(opts.item_reasons!).map(([k, v]) => `<li><b>${esc(ITEM_LABEL[k])}</b>: ${esc(v)}</li>`).join('')}</ul><p>The other documents you sent have been accepted, so please upload <b>only ${Object.keys(opts.item_reasons!).length === 1 ? 'this one' : 'these'}</b> again.`
    : ltd && !isContact
      ? `Accounted4Tax Ltd acts as accountant for <b>${company}</b>. As ${esc(roleLabel(person.role) === 'client' ? 'a director' : 'a ' + roleLabel(person.role))} of ${company}, we need to confirm your identity.`
      : 'Thank you for choosing Accounted4Tax.';
  const sent = await sendEmail('aml_request_client', { email: person.email, name }, {
    person_first_name: esc(name.split(' ')[0] || 'there'), reason_line: reason,
    who_line: ltd ? 'the directors and owners of the companies we act for' : 'every new client',
    needs_list: `<ol style="padding-left:20px;margin:0 0 12px">${(req.needs || needs).map((k: string) => `<li>${NEED_TEXT[k]}</li>`).join('')}</ol>`,
    upload_url: esc(`${base}/id.html?t=${req.upload_token}`), expires: esc(fdate(expires)), phone: esc((S.practice || {}).phone || '07563 811938'),
  }, { client_id: c.id, quote_id: opts.quote_id });
  await db.from('qs_events').insert({ source: opts.by ? 'admin' : 'system', event_type: 'aml_requested', client_id: c.id, quote_id: opts.quote_id || null,
    payload: { request_id: req.id, person: name, role: person.role, email: person.email, email_ok: sent.ok, by: opts.by || null } });
  await refreshClientStatus(c.id);
  return { request: req, email_ok: sent.ok, email_error: sent.error };
}

async function adminEmail(req: any): Promise<string | null> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const u = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await u.auth.getUser();
  const email = data?.user?.email;
  if (!email) return null;
  const { data: a } = await db.from('qs_admins').select('email').ilike('email', email).maybeSingle();
  return a ? email : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  try {
    // ================= INTERNAL =================
    if (action === 'auto') {
      if ((req.headers.get('authorization') || '') !== `Bearer ${SERVICE}`) return fail(401, 'auth', 'Not allowed.');
      const { data: q } = await db.from('qs_quotes').select('id, client:clients(*)').eq('id', body.quote_id).maybeSingle();
      if (!q?.client) return fail(404, 'not_found', 'Quote not found.');
      const c: any = q.client;
      const { data: any_ } = await db.from('qs_aml_requests').select('id').eq('client_id', c.id).neq('status', 'cancelled').limit(1);
      if (any_?.length || c.aml_status === 'verified') return json({ skipped: true });
      const r = await createRequest(c, { name: c.full_name, role: c.client_type === 'ltd' ? 'director' : 'individual', email: c.email }, { quote_id: q.id });
      return json({ request_id: r.request.id, email_ok: r.email_ok });
    }

    // ================= PUBLIC (upload link) =================
    if (['get', 'upload_url', 'submit'].includes(action)) {
      const token = String(body.token || '');
      if (!/^[a-f0-9]{64}$/.test(token)) return fail(404, 'not_found', 'This link is not valid.');
      const { data: r } = await db.from('qs_aml_requests').select('*, client:clients(id,full_name,company_name,trading_name,client_type)').eq('upload_token', token).maybeSingle();
      if (!r) return fail(404, 'not_found', 'This link is not valid.');
      const c: any = r.client;
      if (action === 'get') {
        const S = await settings(['aml_upload_instructions', 'practice']);
        return json({
          needs: r.needs || ITEMS, item_reasons: r.item_reasons || null,
          person: { name: r.person_name, role: roleLabel(r.person_role) }, company: c.client_type === 'ltd' ? c.company_name : null, status: r.status,
          expired: r.status === 'requested' && r.token_expires_at && new Date(r.token_expires_at) < new Date(), expires_at: r.token_expires_at,
          instructions: S.aml_upload_instructions, phone: (S.practice || {}).phone || '07563 811938',
          id_kinds: ID_KINDS, poa_kinds: POA_KINDS.map((p) => ({ ...p, rule_text: RULE_TEXT[p.rule], earliest: earliest(p.rule)?.toISOString().slice(0, 10) || null })),
          not_accepted: NOT_ACCEPTED, max_files: MAX_FILES,
        });
      }
      if (r.status !== 'requested') return fail(409, 'done', r.status === 'received' || r.status === 'verified' ? 'We have already received your documents – thank you.' : 'This link is no longer active. Please contact us.');
      if (r.token_expires_at && new Date(r.token_expires_at) < new Date()) return fail(409, 'expired', 'This link has expired. Please contact us and we will send you a new one.');
      const prefix = `${c.id}/${r.id}/`;

      if (action === 'upload_url') {
        const dt = String(body.doc_type || '');
        if (!MAX_FILES[dt]) return fail(400, 'type', 'Unknown document type.');
        const mime = String(body.mime || '').toLowerCase();
        if (!MIME.includes(mime)) return fail(400, 'mime', 'Please upload a photo (JPG, PNG, HEIC) or a PDF.');
        if (Number(body.size || 0) > 10 * 1024 * 1024) return fail(400, 'size', 'That file is larger than 10 MB. Please take a smaller photo or upload a PDF.');
        const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg');
        const path = `${prefix}${dt}-${Date.now()}-${newToken().slice(0, 8)}.${ext}`;
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
        if (error) throw new Error('upload_url: ' + error.message);
        return json({ path, token: data.token, signed_url: data.signedUrl });
      }

      // submit
      const needs: string[] = r.needs || ITEMS;
      let prevSub: any = {};
      if (r.parent_request_id) { const { data: pr } = await db.from('qs_aml_requests').select('submitted').eq('id', r.parent_request_id).maybeSingle(); prevSub = pr?.submitted || {}; }
      if (!needs.includes('photo_id')) body.id_kind = prevSub.id_kind;
      if (!needs.includes('proof_of_address')) { body.poa_kind = prevSub.poa_kind; body.poa_date = prevSub.poa_date; }
      const idKind = ID_KINDS.find((k) => k.k === body.id_kind), poaKind = POA_KINDS.find((k) => k.k === body.poa_kind);
      if (!idKind) return fail(400, 'id_kind', 'Please choose which photo ID you are uploading.');
      if (!poaKind) return fail(400, 'poa_kind', 'Please choose which proof of address you are uploading.');
      if (idKind.k === 'driving_licence' && poaKind.k === 'driving_licence') return fail(400, 'same', 'You cannot use the same document for photo ID and proof of address. Please choose a different proof of address.');
      let poaDate: Date | null = null;
      if (poaKind.rule !== 'none' && needs.includes('proof_of_address')) {
        poaDate = body.poa_date ? new Date(String(body.poa_date) + 'T00:00:00Z') : null;
        if (!poaDate || isNaN(+poaDate)) return fail(400, 'poa_date', 'Please enter the date on your proof of address.');
        if (poaDate > new Date(today().getTime() + 864e5)) return fail(400, 'poa_date', 'The date on your proof of address cannot be in the future.');
        const min = earliest(poaKind.rule);
        if (min && poaDate < min) return fail(400, 'poa_old', `Your ${poaKind.l.toLowerCase().split(' – ')[0]} must be ${RULE_TEXT[poaKind.rule]}. Please upload a more recent one.`);
      }
      const files: any[] = Array.isArray(body.files) ? body.files : [];
      const by: Record<string, any[]> = { photo_id: [], selfie: [], proof_of_address: [] };
      for (const f of files) {
        if (!by[f.doc_type] || typeof f.path !== 'string' || !f.path.startsWith(prefix)) return fail(400, 'files', 'Something went wrong with an upload. Please try again.');
        by[f.doc_type].push(f);
      }
      for (const t of ITEMS) if (!needs.includes(t) && by[t].length) return fail(400, 'files', 'Something went wrong with an upload. Please reload the page.');
      if (needs.includes('photo_id') && !by.photo_id.length) return fail(400, 'missing', 'Please add a photo of your ID.');
      if (needs.includes('selfie') && !by.selfie.length) return fail(400, 'missing', 'Please add your selfie holding your ID.');
      if (needs.includes('proof_of_address') && !by.proof_of_address.length) return fail(400, 'missing', 'Please add your proof of address.');
      for (const [t, list] of Object.entries(by)) if (list.length > MAX_FILES[t]) return fail(400, 'too_many', 'Too many files.');
      // the files must really be there
      const { data: listed } = await db.storage.from(BUCKET).list(prefix.replace(/\/$/, ''), { limit: 100 });
      const names = new Set((listed || []).map((o: any) => prefix + o.name));
      if (files.some((f) => !names.has(f.path))) return fail(400, 'files', 'An upload did not finish. Please add that file again.');

      const label = { photo_id: `Photo ID – ${idKind.l}`, selfie: 'Selfie holding photo ID', proof_of_address: `Proof of address – ${poaKind.l}` } as any;
      const nowIso = new Date().toISOString();
      for (const f of files) {
        const kind = f.doc_type === 'photo_id' ? idKind.k : f.doc_type === 'proof_of_address' ? poaKind.k : 'selfie';
        const { data: pmDoc } = await db.from('documents').insert({ client_id: c.id, category: f.doc_type === 'proof_of_address' ? 'aml_address' : 'aml_id',
          file_name: `${r.person_name} – ${label[f.doc_type]}${f.file_name ? ` (${String(f.file_name).slice(0, 80)})` : ''}`, file_url: `${BUCKET}/${f.path}`,
          file_size: Number(f.size) || null, mime_type: f.mime || null, uploaded_by: 'client', verified: false, visible_to_client: false,
          notes: f.doc_type === 'proof_of_address' && poaDate ? `Dated ${body.poa_date}` : null }).select('id').single();
        await db.from('qs_aml_documents').insert({ request_id: r.id, client_id: c.id, doc_type: f.doc_type, storage_path: f.path, file_name: String(f.file_name || '').slice(0, 200),
          mime_type: f.mime || null, size_bytes: Number(f.size) || null, doc_kind: kind, doc_date: f.doc_type === 'proof_of_address' ? (body.poa_date || null) : null,
          pm_document_id: pmDoc?.id || null });
      }
      const submitted = { id_kind: idKind.k, id_label: idKind.l, poa_kind: poaKind.k, poa_label: poaKind.l, poa_date: body.poa_date || null, files: files.length, at: nowIso, items: needs,
        ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null, device: (req.headers.get('user-agent') || '').slice(0, 300) };
      await db.from('qs_aml_requests').update({ status: 'received', received_at: nowIso, submitted }).eq('id', r.id);
      await db.from('qs_events').insert({ source: 'client', event_type: 'aml_received', client_id: c.id, quote_id: r.quote_id, payload: { request_id: r.id, person: r.person_name } });
      await refreshClientStatus(c.id);
      const S = await settings(['admin_notify_email']);
      const admin = typeof S.admin_notify_email === 'string' ? S.admin_notify_email : (S.admin_notify_email?.email || 'info@accounted4tax.co.uk');
      await sendEmail('aml_received_admin', { email: admin, name: 'Eduard' }, {
        person_name: esc(r.person_name || ''), role_label: esc(roleLabel(r.person_role)), client_display: esc(displayOf(c)),
        doc_list: [needs.includes('photo_id') ? `<li>${esc(idKind.l)} (${by.photo_id.length} file${by.photo_id.length > 1 ? 's' : ''})</li>` : '',
          needs.includes('selfie') ? '<li>Selfie holding the ID</li>' : '',
          needs.includes('proof_of_address') ? `<li>${esc(poaKind.l)}${poaDate ? ' – dated ' + esc(fdate(body.poa_date)) : ''} (${by.proof_of_address.length} file${by.proof_of_address.length > 1 ? 's' : ''})</li>` : '',
          needs.length < 3 ? '<li>(the other documents were accepted earlier)</li>' : ''].join(''),
        warnings: 'Check the ID is in date, the name matches on both documents, the selfie matches the photo ID, and the address is a home address.',
      }, { client_id: c.id, quote_id: r.quote_id });
      return json({ received: true });
    }

    // ================= ADMIN =================
    const who = await adminEmail(req);
    if (!who) return fail(401, 'auth', 'Please sign in again.');

    if (action === 'people') {
      const { data: c } = await db.from('clients').select('*').eq('id', body.client_id).maybeSingle();
      if (!c) return fail(404, 'not_found', 'Client not found.');
      const people = new Map<string, any>();
      const add = (name: string, role: string, email?: string | null, source = 'client') => {
        if (!name) return;
        const k = nameKey(name), cur = people.get(k);
        if (cur) { if (cur.role !== role && ((cur.role === 'director' && role === 'psc') || (cur.role === 'psc' && role === 'director'))) cur.role = 'director_psc'; if (!cur.email && email) cur.email = email; return; }
        people.set(k, { name: niceName(name), role, email: email || '', source });
      };
      add(c.full_name, c.client_type === 'ltd' ? 'director' : 'individual', c.email, 'contact');
      const snap = c.ch_snapshot || {};
      for (const o of snap.officers || []) if (!o.resigned_on && /director/i.test(o.role || '')) add(o.name, 'director', null, 'companies_house');
      for (const p of snap.pscs || []) if (!p.ceased_on && (p.is_individual !== false) && /individual/i.test(p.kind || 'individual')) add(p.name, 'psc', null, 'companies_house');
      const { data: reqs } = await db.from('qs_aml_requests').select('id,person_name,person_role,person_email,status,requested_at,received_at,verified_at,token_expires_at,notes,submitted,created_at').eq('client_id', c.id).neq('status', 'cancelled').order('created_at', { ascending: false });
      for (const r of reqs || []) add(r.person_name, r.person_role || 'director', r.person_email, 'request');
      const { data: recs } = await db.from('aml_records').select('*').eq('client_id', c.id);
      const out = [...people.values()].map((p) => {
        const mine = (reqs || []).filter((r: any) => nameKey(r.person_name || '') === nameKey(p.name));
        const latest = mine[0] || null;
        const rec = (recs || []).find((x: any) => nameKey(x.director_name || '') === nameKey(p.name)) || null;
        return { ...p, email: p.email || latest?.person_email || '', request: latest, record: rec, history: mine.length };
      });
      return json({ client: { id: c.id, name: displayOf(c), type: c.client_type, aml_status: c.aml_status }, people: out });
    }

    if (action === 'request') {
      const { data: c } = await db.from('clients').select('*').eq('id', body.client_id).maybeSingle();
      if (!c) return fail(404, 'not_found', 'Client not found.');
      const email = String(body.email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'email', 'Please enter a valid email address.');
      const role = ['individual', 'director', 'psc', 'director_psc'].includes(body.person_role) ? body.person_role : 'director';
      const r = await createRequest(c, { name: String(body.person_name || '').trim(), role, email }, { by: who });
      return json({ request_id: r.request.id, email_ok: r.email_ok, email_error: r.email_error });
    }

    // the documents that count for one person: for each item, the latest upload of it along the chain of links
    async function effectiveDocs(requestId: string) {
      const chain: any[] = [];
      let id: string | null = requestId;
      while (id && chain.length < 10) {
        const { data: x } = await db.from('qs_aml_requests').select('id,parent_request_id,needs,review,received_at').eq('id', id).maybeSingle();
        if (!x) break; chain.push(x); id = x.parent_request_id;
      }
      const out: Record<string, { request_id: string; current: boolean; docs: any[]; earlier_ok: boolean }> = {};
      for (const t of ITEMS) {
        const src = chain.find((x) => (x.needs || ITEMS).includes(t));
        if (!src) continue;
        const { data: docs } = await db.from('qs_aml_documents').select('*').eq('request_id', src.id).eq('doc_type', t).order('created_at');
        out[t] = { request_id: src.id, current: src.id === requestId, docs: docs || [], earlier_ok: src.id !== requestId };
      }
      return out;
    }

    if (action === 'docs') {
      const eff = await effectiveDocs(body.request_id);
      const items: any[] = [];
      for (const t of ITEMS) {
        const e = eff[t]; if (!e) continue;
        const files = [];
        for (const d of e.docs) {
          const { data: u } = await db.storage.from(BUCKET).createSignedUrl(d.storage_path, 600);
          files.push({ id: d.id, doc_kind: d.doc_kind, doc_date: d.doc_date, file_name: d.file_name, mime: d.mime_type, url: u?.signedUrl || null });
        }
        items.push({ item: t, label: ITEM_LABEL[t], current: e.current, accepted_earlier: e.earlier_ok, files });
      }
      const { data: r } = await db.from('qs_aml_requests').select('person_name,status,submitted,received_at,needs,review,item_reasons').eq('id', body.request_id).maybeSingle();
      return json({ request: r, items });
    }

    if (action === 'review') {
      const { data: r } = await db.from('qs_aml_requests').select('*, client:clients(*)').eq('id', body.request_id).maybeSingle();
      if (!r) return fail(404, 'not_found', 'Request not found.');
      if (r.status !== 'received') return fail(409, 'state', r.status === 'verified' ? 'Already verified.' : 'Documents have not been received yet.');
      const c: any = r.client;
      const nowIso = new Date().toISOString(), d = nowIso.slice(0, 10);
      const needs: string[] = r.needs || ITEMS;
      const items = body.items || {};
      const decisions: Record<string, { ok: boolean; reason?: string }> = {};
      for (const t of needs) {
        const x = items[t];
        if (!x || (x.ok !== true && x.ok !== false)) return fail(400, 'undecided', `Please tick or cross ${ITEM_LABEL[t].toLowerCase()}.`);
        if (x.ok === false && String(x.reason || '').trim().length < 3) return fail(400, 'reason', `Please give a reason for ${ITEM_LABEL[t].toLowerCase()}, so the person knows what to send.`);
        decisions[t] = x.ok ? { ok: true } : { ok: false, reason: String(x.reason).trim().slice(0, 300) };
      }
      const rejected = Object.entries(decisions).filter(([, v]) => !v.ok);
      const eff = await effectiveDocs(r.id);
      // tick / cross on the Practice Manager document records
      for (const t of needs) {
        const ids = (eff[t]?.docs || []).map((x: any) => x.pm_document_id).filter(Boolean);
        if (ids.length) await db.from('documents').update(decisions[t].ok ? { verified: true, verified_at: nowIso } : { verified: false, notes: `Not accepted: ${decisions[t].reason}` }).in('id', ids);
      }
      if (rejected.length) {
        await db.from('qs_aml_requests').update({ status: 'rejected', reviewed_by: who, review: decisions,
          notes: 'Not accepted: ' + rejected.map(([k, v]) => `${ITEM_LABEL[k]} – ${v.reason}`).join('; ') }).eq('id', r.id);
        const again = await createRequest(c, { name: r.person_name, role: r.person_role, email: r.person_email },
          { by: who, needs: rejected.map(([k]) => k), item_reasons: Object.fromEntries(rejected.map(([k, v]) => [k, v.reason!])), parent_request_id: r.id, quote_id: r.quote_id });
        await db.from('qs_events').insert({ source: 'admin', event_type: 'aml_rejected', client_id: c.id, quote_id: r.quote_id, payload: { request_id: r.id, person: r.person_name, by: who, items: decisions } });
        return json({ rejected: true, asked_again: rejected.map(([k]) => k), new_request_id: again.request.id, email_ok: again.email_ok });
      }
      // all accepted → CDD verified
      const sub = r.submitted || {};
      const pep = ['no', 'yes', 'close_associate'].includes(body.pep_check) ? body.pep_check : 'no';
      const sanc = ['not_checked', 'clear', 'match'].includes(body.sanctions_check) ? body.sanctions_check : 'not_checked';
      const risk = ['low', 'medium', 'high'].includes(body.risk_rating) ? body.risk_rating : 'low';
      const review = new Date(); review.setUTCFullYear(review.getUTCFullYear() + (risk === 'high' ? 1 : risk === 'medium' ? 2 : 3));
      const rec = { client_id: c.id, director_name: r.person_name, id_type: sub.id_label || sub.id_kind || null, id_verified: true, id_verified_date: d,
        address_type: sub.poa_label || sub.poa_kind || null, address_verified: true, address_verified_date: d, pep_check: pep, sanctions_check: sanc,
        sanctions_check_date: sanc === 'not_checked' ? null : d, risk_rating: risk, review_date: review.toISOString().slice(0, 10),
        notes: [body.notes, `Verified online by ${who} on ${d}${sub.poa_date ? `; proof of address dated ${sub.poa_date}` : ''}.`].filter(Boolean).join(' '),
        qs_aml_request_id: r.id };
      const { data: existing } = await db.from('aml_records').select('id,director_name').eq('client_id', c.id);
      const same = (existing || []).find((x: any) => nameKey(x.director_name || '') === nameKey(r.person_name || ''));
      const { data: saved, error } = same
        ? await db.from('aml_records').update(rec).eq('id', same.id).select('id').single()
        : await db.from('aml_records').insert(rec).select('id').single();
      if (error) throw new Error('aml_records: ' + error.message);
      await db.from('qs_aml_requests').update({ status: 'verified', verified_at: nowIso, reviewed_by: who, review: decisions, pm_aml_record_id: saved.id }).eq('id', r.id);
      await db.from('qs_events').insert({ source: 'admin', event_type: 'aml_verified', client_id: c.id, quote_id: r.quote_id, payload: { request_id: r.id, person: r.person_name, by: who, risk, pep, sanctions: sanc } });
      const status = await refreshClientStatus(c.id);
      return json({ verified: true, client_aml_status: status });
    }

    return fail(400, 'bad_request', 'Unknown action.');
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    await db.from('qs_events').insert({ source: 'system', event_type: 'aml_error', payload: { action, error: msg } });
    return fail(500, 'server', 'Something went wrong. Please try again in a minute.');
  }
});
