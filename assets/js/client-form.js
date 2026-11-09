// A4T Quotes - shared client form (Clients page and quote builder).
// A4TClientForm.open(clientOrNull, onSaved(clientRow)) shows a bottom sheet.
// For limited companies, typing the company name or number searches Companies House and
// fills name, number, registered office, year end, officers, PSCs and outstanding accounts.
(function () {
  const esc = (s) => A4T.esc(s);
  const fmt = (d) => d ? new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const TYPES = [['sole_trader', 'Sole trader'], ['landlord', 'Landlord'], ['ltd', 'Limited company']];

  async function ch(body) {
    const res = await A4T.sb.functions.invoke('companies-house-lookup', { body });
    if (res.error) {
      let msg = res.error.message;
      try { const b = await res.error.context.json(); if (b.error) msg = b.error.message; } catch (_) {}
      throw new Error(msg);
    }
    return res.data;
  }

  function markup() {
    return `
    <div class="sheet-backdrop" id="cf-backdrop"></div>
    <section class="sheet" id="cf-sheet" role="dialog" aria-modal="true" aria-labelledby="cf-title">
      <div class="sheet-head"><h2 id="cf-title">Client</h2><button class="x-btn" type="button" id="cf-close" aria-label="Close">×</button></div>
      <div id="cf-err" class="alert alert-error" role="alert"></div>
      <form id="cf-form" novalidate>
        <div class="field"><label>Client type</label>
          <div class="seg" id="cf-type">${TYPES.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>
        </div>

        <div id="cf-ltd">
          <div class="field ta">
            <label for="cf-company">Company name or number</label>
            <input id="cf-company" type="text" autocomplete="off" placeholder="Start typing to search Companies House">
            <div class="ta-list" id="cf-list" role="listbox"></div>
          </div>
          <div id="cf-ch" class="co-block"></div>
          <div class="row2">
            <div class="field"><label for="cf-crn">Company number</label><input id="cf-crn" type="text" maxlength="8"></div>
            <div class="field"><label for="cf-ye">Year end (current)</label><input id="cf-ye" type="date"></div>
          </div>
          <div class="field"><label for="cf-ctutr">Corporation Tax UTR</label><input id="cf-ctutr" type="text" inputmode="numeric" maxlength="10"></div>
        </div>

        <div class="field" id="cf-trading-wrap"><label for="cf-trading">Business / trading name <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input id="cf-trading" type="text" maxlength="120"></div>
        <div class="field"><label for="cf-name" id="cf-name-label">Full name</label><input id="cf-name" type="text" maxlength="120" autocomplete="name"></div>
        <div class="row2">
          <div class="field"><label for="cf-email">Email</label><input id="cf-email" type="email" autocomplete="email"></div>
          <div class="field"><label for="cf-phone">Phone</label><input id="cf-phone" type="tel" autocomplete="tel"></div>
        </div>
        <div class="field"><label for="cf-address" id="cf-address-label">Address</label><textarea id="cf-address" rows="2"></textarea></div>
        <div class="field" id="cf-utr-wrap"><label for="cf-utr">Self Assessment UTR</label><input id="cf-utr" type="text" inputmode="numeric" maxlength="10"></div>
        <div class="field"><label for="cf-notes">Notes <span style="font-weight:400;color:var(--muted)">(only you see these)</span></label><textarea id="cf-notes" rows="2"></textarea></div>
        <div class="sheet-foot">
          <button type="button" class="btn btn-ghost" id="cf-cancel">Cancel</button>
          <button type="submit" class="btn btn-teal" id="cf-save">Save client</button>
        </div>
      </form>
    </section>`;
  }

  let state = null, onSavedCb = null, timer = null, seq = 0, results = [];

  function ensure() {
    if (document.getElementById('cf-sheet')) return;
    const wrap = document.createElement('div'); wrap.innerHTML = markup(); document.body.appendChild(wrap);
    const $ = (id) => document.getElementById(id);
    $('cf-close').onclick = close; $('cf-cancel').onclick = close; $('cf-backdrop').onclick = close;
    $('cf-type').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; state.client_type = b.dataset.v; sync(); };
    $('cf-form').onsubmit = save;

    // Companies House type-ahead
    const q = $('cf-company'), list = $('cf-list');
    q.addEventListener('input', () => {
      clearTimeout(timer);
      const v = q.value.trim();
      if (v.length < 2) { list.classList.remove('open'); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          if (/^([A-Za-z]{2})?\d{6,8}$/.test(v.replace(/\s/g, ''))) { list.classList.remove('open'); return pick(v); }
          const d = await ch({ search: v });
          if (my !== seq) return;
          results = d.results || [];
          list.innerHTML = results.length ? results.map((r, i) => `<div class="ta-item" data-i="${i}"><b>${esc(r.company_name)}</b>
            <span>${esc(r.company_number)} · <span class="${r.company_status === 'active' ? '' : 'st-dissolved'}">${esc(r.company_status || '')}</span>${r.address_snippet ? ' · ' + esc(r.address_snippet) : ''}</span></div>`).join('')
            : '<div class="ta-item"><span>No companies found</span></div>';
          list.classList.add('open');
        } catch (e) { list.innerHTML = `<div class="ta-item"><span class="warn">${esc(e.message)}</span></div>`; list.classList.add('open'); }
      }, 350);
    });
    list.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (!it) return; const r = results[Number(it.dataset.i)]; list.classList.remove('open'); q.value = r.company_name; pick(r.company_number); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#cf-sheet .ta')) list.classList.remove('open'); });
  }

  async function pick(number) {
    const $ = (id) => document.getElementById(id);
    $('cf-ch').innerHTML = '<p class="hint">Loading company details…</p>';
    try {
      const c = await ch({ company_number: number });
      state.ch_snapshot = c;
      $('cf-company').value = c.company_name || '';
      $('cf-crn').value = c.company_number || '';
      $('cf-address').value = (c.registered_office.lines || []).concat(c.registered_office.postcode ? [c.registered_office.postcode] : []).join('\n');
      if (!state.year_end_overridden || !$('cf-ye').value) $('cf-ye').value = c.upcoming_year_end || '';
      state.year_end_overridden = false;
      // First active director as the contact name if empty
      const dir = (c.officers || []).find(o => o.role === 'director');
      if (dir && !$('cf-name').value) $('cf-name').value = toFirstLast(dir.name);
      renderCh();
    } catch (e) { $('cf-ch').innerHTML = `<p class="warn">${esc(e.message)}</p>`; }
  }

  // "HUSARU, Eduard Ion" -> "Eduard Ion Husaru"
  function toFirstLast(n) {
    const [last, first] = String(n || '').split(',').map(s => s.trim());
    const cap = (s) => s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, m => m.toUpperCase());
    return first ? `${first} ${cap(last)}` : cap(last);
  }

  function renderCh() {
    const c = state.ch_snapshot, el = document.getElementById('cf-ch');
    if (!c || state.client_type !== 'ltd') { el.innerHTML = ''; return; }
    const os = c.outstanding_accounts || [];
    const person = (p, extra) => `<div class="person"><b>${esc(p.name)}</b> ${extra}<small>Service address: ${esc(p.address.single_line || '—')}</small></div>`;
    el.innerHTML = `
      <dl class="kv">
        <dt>Status</dt><dd class="${c.company_status === 'active' ? '' : 'warn'}">${esc(c.company_status)}</dd>
        <dt>Year end</dt><dd>${esc(c.accounting_reference_date.label || '—')}</dd>
        <dt>Outstanding accounts</dt><dd>${os.length ? os.map(p => `to ${esc(fmt(p.period_end))}, due ${esc(fmt(p.due_date))}${p.overdue ? ' <span class="warn">OVERDUE</span>' : ''}`).join('<br>') : 'None'}</dd>
        <dt>Confirmation stmt</dt><dd>due ${esc(fmt(c.confirmation_statement_due_date))}${c.confirmation_statement_overdue ? ' <span class="warn">OVERDUE</span>' : ''}</dd>
      </dl>
      <h3>Officers (${c.officers.length})</h3>${c.officers.map(o => person(o, `<small>${esc(String(o.role || '').replace(/-/g, ' '))}</small>`)).join('')}
      <h3>People with significant control (${c.pscs.length})</h3>${c.pscs.map(p => person(p, `<small>${esc(p.control_summary.join('; '))}</small>`)).join('') || '<p class="hint">None listed</p>'}
      <p class="hint">Checked with Companies House ${esc(fmt(String(c.fetched_at).slice(0, 10)))}.</p>`;
  }

  function sync() {
    const $ = (id) => document.getElementById(id);
    document.querySelectorAll('#cf-type [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === state.client_type));
    const ltd = state.client_type === 'ltd';
    $('cf-ltd').style.display = ltd ? '' : 'none';
    $('cf-trading-wrap').style.display = ltd ? 'none' : '';
    $('cf-utr-wrap').style.display = ltd ? 'none' : '';
    $('cf-name-label').textContent = ltd ? 'Contact name (director)' : 'Full name';
    $('cf-address-label').textContent = ltd ? 'Registered office' : 'Home address';
    renderCh();
  }

  function open(client, onSaved) {
    ensure();
    onSavedCb = onSaved || null;
    state = client ? { ...client } : { id: null, client_type: 'sole_trader', ch_snapshot: null };
    const $ = (id) => document.getElementById(id);
    $('cf-title').textContent = client ? 'Edit client' : 'New client';
    $('cf-err').classList.remove('show');
    $('cf-company').value = state.company_name || '';
    $('cf-crn').value = state.crn || '';
    $('cf-ye').value = state.year_end_date || '';
    $('cf-ctutr').value = state.ct_utr || '';
    $('cf-trading').value = state.trading_name || '';
    $('cf-name').value = state.full_name || '';
    $('cf-email').value = state.email || '';
    $('cf-phone').value = state.phone || '';
    $('cf-address').value = state.address || '';
    $('cf-utr').value = state.utr || '';
    $('cf-notes').value = state.notes_general || '';
    sync();
    $('cf-backdrop').classList.add('open'); $('cf-sheet').classList.add('open');
  }
  function close() { document.getElementById('cf-backdrop').classList.remove('open'); document.getElementById('cf-sheet').classList.remove('open'); }

  async function save(e) {
    e.preventDefault();
    const $ = (id) => document.getElementById(id);
    const err = (t) => { $('cf-err').textContent = t; $('cf-err').classList.add('show'); $('cf-sheet').scrollTop = 0; };
    const ltd = state.client_type === 'ltd';
    const v = (id) => $(id).value.trim();
    if (ltd && !v('cf-company')) return err('Enter the company name.');
    if (!v('cf-name')) return err(ltd ? 'Enter a contact name.' : 'Enter the client\'s full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('cf-email'))) return err('Enter a valid email address.');
    if (v('cf-utr') && !/^\d{10}$/.test(v('cf-utr').replace(/\s/g, ''))) return err('A UTR has 10 digits.');
    if (v('cf-ctutr') && !/^\d{10}$/.test(v('cf-ctutr').replace(/\s/g, ''))) return err('A Corporation Tax UTR has 10 digits.');
    const chYe = state.ch_snapshot && state.ch_snapshot.upcoming_year_end;
    const row = {
      client_type: state.client_type,
      full_name: v('cf-name'),
      email: v('cf-email').toLowerCase(),
      phone: v('cf-phone') || null,
      address: v('cf-address') || null,
      notes_general: v('cf-notes') || null,
      company_name: ltd ? v('cf-company') : null,
      crn: ltd ? (v('cf-crn').toUpperCase() || null) : null,
      ct_utr: ltd ? (v('cf-ctutr').replace(/\s/g, '') || null) : null,
      year_end_date: ltd ? (v('cf-ye') || null) : null,
      year_end_overridden: ltd && !!chYe && v('cf-ye') !== chYe,
      ch_snapshot: ltd ? state.ch_snapshot || null : null,
      trading_name: ltd ? null : (v('cf-trading') || null),
      utr: ltd ? null : (v('cf-utr').replace(/\s/g, '') || null),
    };
    $('cf-save').disabled = true; $('cf-save').textContent = 'Saving…';
    try {
      let saved;
      if (state.id) {
        const { data, error } = await A4T.sb.from('clients').update(row).eq('id', state.id).select('*').single();
        if (error) throw error; saved = data;
      } else {
        const { data, error } = await A4T.sb.from('clients').insert(row).select('*').single();
        if (error) throw error; saved = data;
      }
      close();
      if (onSavedCb) onSavedCb(saved);
    } catch (ex) { err('Could not save: ' + ex.message); }
    finally { $('cf-save').disabled = false; $('cf-save').textContent = 'Save client'; }
  }

  window.A4TClientForm = { open, close, toFirstLast };
})();
