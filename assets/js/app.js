// A4T Quotes - shared helpers used by every admin page.
(function () {
  const cfg = window.A4T_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // Returns the session if the signed-in user is an admin, otherwise sends them to the login page.
  async function requireAdmin() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.replace('index.html'); return null; }
    const { data: isAdmin, error } = await sb.rpc('qs_is_admin');
    if (error || !isAdmin) {
      await sb.auth.signOut();
      window.location.replace('index.html?denied=1');
      return null;
    }
    return session;
  }

  async function signOut() {
    await sb.auth.signOut();
    window.location.replace('index.html');
  }

  function money(n) {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(n || 0));
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Shared bottom/top navigation. Put <nav class="bottom-nav" id="nav"></nav> in the page.
  function nav(active) {
    const items = [['dashboard', 'dashboard.html', '▦', 'Dashboard'], ['quotes', 'quotes.html', '✎', 'Quotes'],
      ['clients', 'clients.html', '☺', 'Clients'], ['services', 'services.html', '£', 'Services'], ['settings', '#', '⚙', 'Settings']];
    const el = document.getElementById('nav'); if (!el) return;
    el.setAttribute('aria-label', 'Main');
    el.innerHTML = items.map(([k, href, ic, label]) =>
      `<a href="${href}" class="${k === active ? 'active' : ''} ${href === '#' ? 'soon' : ''}"><span class="ic">${ic}</span>${label}</a>`).join('');
  }

  function toast(t) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function fmtDate(d) {
    if (!d) return '—';
    const s = String(d); const dt = new Date(s.length === 10 ? s + 'T00:00:00' : s);
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  window.A4T = { sb, requireAdmin, signOut, money, esc, nav, toast, fmtDate };
})();
