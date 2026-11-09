// A4T Quotes - pricing engine. One place that turns a service + quantity into a price.
// Used by the Services page (price check) and later by the Quote builder.
//
// service: a services_catalogue row (Practice Manager), plus `bands` = qs_service_price_bands rows
// qty:     transactions / employees / subcontractors (ignored for fixed)
// Returns { price, detail } or { price: null, error }
(function (root) {
  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  function findBand(bands, qty) {
    const sorted = [...(bands || [])].sort((a, b) => Number(a.min_qty) - Number(b.min_qty));
    return sorted.find(b => qty >= Number(b.min_qty) && (b.max_qty === null || b.max_qty === '' || b.max_qty === undefined || qty <= Number(b.max_qty)));
  }

  function bandLabel(b) {
    return (b.max_qty === null || b.max_qty === '' || b.max_qty === undefined) ? `${b.min_qty}+` : `${b.min_qty}–${b.max_qty}`;
  }

  function calcPrice(service, qty) {
    const type = service.pricing_type;
    if (type === 'fixed') {
      if (service.default_price === null || service.default_price === undefined || service.default_price === '')
        return { price: null, error: 'No price set' };
      return { price: round2(service.default_price), detail: 'Fixed price' };
    }

    const q = Number(qty);
    if (!Number.isFinite(q) || q < 0 || (type !== 'income_based' && !Number.isInteger(q)))
      return { price: null, error: type === 'income_based' ? 'Enter the estimated income' : 'Enter a whole number' };
    const unit = service.unit_label || 'units';

    if (service.use_bands) {
      const band = findBand(service.bands, q);
      if (!band) return { price: null, error: `No band covers ${q} ${unit}` };
      return { price: round2(band.price), detail: `Band ${bandLabel(band)} ${unit}` };
    }

    const base = Number(service.base_fee || 0);
    const rate = Number(service.per_unit_rate || 0);
    const size = Number(service.unit_size || 1) > 0 ? Number(service.unit_size || 1) : 1;
    const included = Math.max(0, Number(service.included_units || 0));
    // Income: every started step counts (£1–£10,000 = 1, £10,001–£20,000 = 2). Head counts: whole units.
    // Batches (unit size > 1, e.g. £30 per batch of up to 50 transactions): every started batch counts too.
    const units = (type === 'income_based' || size > 1) ? Math.ceil(q / size) : Math.floor(q / size);
    const charged = Math.max(0, units - included);  // e.g. 8 employees, 5 included = 3 charged
    const money = (n) => '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let detail;
    if (type === 'income_based') detail = `${money(base)} base + ${charged} × ${money(rate)} (each £${size.toLocaleString('en-GB')} or part of income)`;
    else if (size > 1) detail = `${units} batch${units === 1 ? '' : 'es'} of up to ${size.toLocaleString('en-GB')} ${unit} × ${money(rate)}${included ? ` (${included} included)` : ''}`;
    else if (included) detail = `${money(base)} covers up to ${included}; ${charged} extra × ${money(rate)}`;
    else detail = `${money(base)} base + ${charged} × ${money(rate)}`;
    return { price: round2(base + rate * charged), detail };
  }

  // Checks bands for gaps/overlaps. Returns a list of problems (empty = fine).
  function checkBands(bands) {
    const problems = [];
    const sorted = [...(bands || [])].map(b => ({
      min: Number(b.min_qty), max: (b.max_qty === null || b.max_qty === '' || b.max_qty === undefined) ? Infinity : Number(b.max_qty), price: b.price
    })).sort((a, b) => a.min - b.min);
    if (!sorted.length) return ['Add at least one band'];
    sorted.forEach((b, i) => {
      if (!Number.isFinite(b.min) || b.min < 0) problems.push(`Band ${i + 1}: "from" must be 0 or more`);
      if (b.max < b.min) problems.push(`Band ${i + 1}: "to" is lower than "from"`);
      if (b.price === '' || b.price === null || !Number.isFinite(Number(b.price))) problems.push(`Band ${i + 1}: enter a price`);
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev.max === Infinity) problems.push(`Band ${i}: has no upper limit but another band follows it`);
        else if (b.min <= prev.max) problems.push(`Bands ${i} and ${i + 1} overlap`);
        else if (b.min > prev.max + 1) problems.push(`Gap between ${prev.max} and ${b.min}`);
      }
    });
    if (sorted[0] && sorted[0].min > 0) problems.push(`Nothing covers 0–${sorted[0].min - 1}`);
    return problems;
  }

  // Price per year for ongoing services (monthly prices x 12). One-off fees are returned unchanged.
  function annualise(service, periodPrice) {
    if (periodPrice === null || periodPrice === undefined) return null;
    return service.price_period === 'monthly' ? round2(periodPrice * 12) : round2(periodPrice);
  }

  const PERIOD_SUFFIX = { one_off: '', monthly: ' / month', annual: ' / year' };
  function periodSuffix(service) { return PERIOD_SUFFIX[service.price_period] || ''; }

  // Deposit now, balance before submission (e.g. Self Assessment: £99 now, rest before filing).
  function splitDeposit(service, price) {
    if (service.payment_structure !== 'deposit_balance' || price === null || price === undefined) return null;
    const deposit = round2(Math.min(Number(service.deposit_amount || 0), price));
    return { deposit, balance: round2(price - deposit) };
  }

  const api = { calcPrice, checkBands, bandLabel, round2, annualise, periodSuffix, splitDeposit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.A4TPricing = api;
})(typeof window !== 'undefined' ? window : globalThis);
