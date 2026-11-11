// stripe — tiny Stripe REST helper for Edge Functions (no SDK). Secret: STRIPE_SECRET_KEY (sandbox sk_test_… or live sk_live_…).
// API version pinned so behaviour does not change when Stripe releases a new version.
// deno-lint-ignore-file no-explicit-any
export const STRIPE_VERSION = '2026-10-28.endive';
const key = () => {
  const k = Deno.env.get('STRIPE_SECRET_KEY');
  if (!k) throw new Error('stripe_key_missing');
  return k;
};
export const stripeLive = () => (Deno.env.get('STRIPE_SECRET_KEY') || '').startsWith('sk_live') || (Deno.env.get('STRIPE_SECRET_KEY') || '').startsWith('rk_live');

// nested objects/arrays → Stripe form encoding: a[b][0][c]=1
function enc(obj: any, prefix = '', out: [string, string][] = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x !== null && typeof x === 'object') ? enc(x, `${name}[${i}]`, out) : out.push([`${name}[${i}]`, String(x)]));
    else if (typeof v === 'object') enc(v, name, out);
    else out.push([name, String(v)]);
  }
  return out;
}

export async function stripe(method: 'GET' | 'POST' | 'DELETE', path: string, params?: any, idempotencyKey?: string): Promise<any> {
  const body = new URLSearchParams(enc(params || {})).toString();
  const url = `https://api.stripe.com/v1/${path}` + (method === 'GET' && body ? `?${body}` : '');
  const headers: Record<string, string> = { Authorization: `Bearer ${key()}`, 'Stripe-Version': STRIPE_VERSION };
  if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: any = new Error(`stripe ${method} ${path}: ${j?.error?.message || res.status}`);
    e.status = res.status; e.code = j?.error?.code; throw e;
  }
  return j;
}

export const pence = (n: number) => Math.round(Number(n || 0) * 100);

// Verify a webhook (Stripe-Signature: t=…,v1=…) against STRIPE_WEBHOOK_SECRET. 5-minute tolerance.
export async function verifyWebhook(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2));
  const t = parts['t'];
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => s.length === hex.length && [...s].reduce((a, c, i) => a | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}
