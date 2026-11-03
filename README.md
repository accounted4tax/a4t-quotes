# A4T Quotes

Quote, engagement letter and payment system for **Accounted4Tax Ltd** (CRN 16438537).

- **Frontend:** static HTML/CSS/JS, hosted on GitHub Pages.
- **Backend:** Supabase project `accounted4tax-practice` (shared with the Practice Manager). All tables, storage buckets and functions for this app are prefixed `qs_`.
- **Payments:** Stripe. **Email:** Brevo. **Company data:** Companies House API.

## Security

This repository is public. It contains **no secrets**:

- `assets/js/config.js` holds only the Supabase URL and the *publishable* key, which are designed to be public.
- Every `qs_` table has Row Level Security. Only emails listed in `qs_admins` can read or write data.
- Stripe, Brevo and Companies House keys are stored only as Supabase Edge Function secrets.
- Client-facing pages (quote link, AML upload, renewal approval) never read tables directly; they call Edge Functions that check the secret link token.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Admin sign-in |
| `dashboard.html` | Admin dashboard |
| `services.html` | Services & pricing catalogue |
| `assets/js/pricing.js` | Pricing engine shared by Services and (later) the Quote builder |

## Edge Functions

Source lives in `supabase/functions/` (deployed to Supabase; this copy is for reference).

- `companies-house-lookup`: company number in, Companies House profile + officers out. Admin login required. Needs secret `COMPANIES_HOUSE_API_KEY`. Usage documented at the top of `index.ts`.

## Build phases

1. Setup: repo, Supabase tables with RLS, admin login ✅
2. Companies House lookup (built, waiting for API key)
3. Services & pricing catalogue ✅
4. Quote builder, discounts, payment calculation, client quote page, Brevo
5. Engagement letter, acceptance & signature, signed PDF
6. Stripe Checkout, subscriptions, webhook, Customer Portal
7. Post-payment automation: emails, AML upload, HMRC authorisation, 64-8
8. Reminders, expiry, renewals, dashboard statuses
9. End-to-end testing, then Stripe LIVE
