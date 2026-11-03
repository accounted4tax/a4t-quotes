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

  window.A4T = { sb, requireAdmin, signOut, money, esc };
})();
