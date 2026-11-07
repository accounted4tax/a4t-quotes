// A4T Quotes - quote calculation. Turns quote lines into amounts and a payment schedule.
// Used by the quote builder (admin). The same rules will run server-side before charging.
//
// RULES (agreed with Eduard)
// - One-off: catch-up services, earlier years, one-off fees. Paid in full on acceptance.
// - Deposit + balance (e.g. Self Assessment): deposit on acceptance, balance before submission.
// - Ongoing (current year): client chooses pay in full now OR monthly until the year end.
//   Monthly amount = ongoing total / number of payments left before the year end.
// - Payments are on the same day each month from the start date; the last one is on or before the year end.
// - Late start (payments left <= threshold, default 2): monthly is not offered by default; the
//   ongoing total is paid in one go, unless Eduard sets a number of instalments for this quote.
// - Line discounts first, then the whole-quote discount (% on every line, or a fixed £ shared
//   across lines in proportion to their value). Discounts apply to this period only.
(function (root) {
  const P = root.A4TPricing || (typeof require !== 'undefined' ? require('./pricing.js') : null);
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // ---------- dates (all ISO yyyy-mm-dd, timezone-free) ----------
  function parse(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return { y, m, d }; }
  function iso(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addMonths(isoDate, k) {
    const { y, m, d } = parse(isoDate);
    const t = (m - 1) + k, ny = y + Math.floor(t / 12), nm = (t % 12 + 12) % 12 + 1;
    return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
  }
  function todayISO() { const n = new Date(); return iso(n.getFullYear(), n.getMonth() + 1, n.getDate()); }

  // Next 5 April on/after a date (sole traders, landlords)
  function nextTaxYearEnd(fromIso) {
    const { y } = parse(fromIso);
    const thisYear = iso(y, 4, 5);
    return fromIso <= thisYear ? thisYear : iso(y + 1, 4, 5);
  }
  // "2026/27" for the tax year ending 5 April 2027
  function taxYearLabel(yearEndIso) {
    const { y } = parse(yearEndIso);
    return `${y - 1}/${String(y).slice(-2)}`;
  }
  // Payment dates: start, start+1m, ... while <= year end
  function paymentDates(startIso, yearEndIso, max = 36) {
    const out = [];
    for (let k = 0; k < max; k++) {
      const d = addMonths(startIso, k);
      if (d > yearEndIso) break;
      out.push(d);
    }
    return out;
  }

  // ---------- main ----------
  // quote: { start_date, year_end_date, discount_type, discount_value, late_start_mode, payments_count }
  // lines: [{ service, quantity, price_override (number|null), discount_type, discount_value,
  //           is_earlier_year, months }]  -- service = catalogue row (+bands)
  // settings: { late_start_threshold_months }
  function compute(quote, lines, settings = {}) {
    const errors = [];
    const threshold = Number(settings.late_start_threshold_months ?? 2);

    // 1. Each line before the whole-quote discount
    const L = lines.map((ln, i) => {
      const s = ln.service || {};
      let unit = null, detail = '';
      if (ln.price_override !== null && ln.price_override !== undefined && ln.price_override !== '') {
        unit = r2(ln.price_override); detail = 'Price set manually';
      } else {
        const res = P.calcPrice(s, ln.quantity);
        if (res.price === null) errors.push(`${s.name || 'Line ' + (i + 1)}: ${res.error}`);
        unit = res.price === null ? 0 : res.price; detail = res.detail || '';
      }
      const monthly = s.price_period === 'monthly';
      const months = monthly ? Math.max(1, Math.min(24, Number(ln.months || 12))) : null;
      const gross = r2(monthly ? unit * months : unit);
      if (monthly) detail += `${detail ? ' · ' : ''}${months} month${months === 1 ? '' : 's'} × £${unit.toFixed(2)}`;

      let lineDisc = 0;
      const dv = Number(ln.discount_value || 0);
      if (ln.discount_type === 'percent') lineDisc = r2(gross * Math.min(100, Math.max(0, dv)) / 100);
      else if (ln.discount_type === 'fixed') lineDisc = r2(Math.min(gross, Math.max(0, dv)));

      let kind;
      if (s.payment_structure === 'deposit_balance') kind = 'deposit_balance';
      else if (ln.is_earlier_year || s.service_kind === 'catch_up' || s.price_period === 'one_off') kind = 'one_off';
      else kind = 'ongoing';

      return { ...ln, unit_price: unit, months, gross, line_discount: lineDisc, after_line: r2(gross - lineDisc), kind, detail };
    });

    // 2. Whole-quote discount
    const base = r2(L.reduce((a, x) => a + x.after_line, 0));
    let quoteDisc = 0;
    const qv = Number(quote.discount_value || 0);
    if (quote.discount_type === 'percent') quoteDisc = r2(base * Math.min(100, Math.max(0, qv)) / 100);
    else if (quote.discount_type === 'fixed') quoteDisc = r2(Math.min(base, Math.max(0, qv)));
    let left = quoteDisc;
    L.forEach((x, i) => {
      let share;
      if (quote.discount_type === 'percent') share = r2(x.after_line * Math.min(100, Math.max(0, qv)) / 100);
      else share = base > 0 ? r2(quoteDisc * x.after_line / base) : 0;
      if (i === L.length - 1 && quote.discount_type === 'fixed') share = r2(left); // pennies to the last line
      share = Math.min(share, x.after_line);
      left = r2(left - share);
      x.quote_discount = share;
      x.net = r2(x.after_line - share);
      x.discount_amount = r2(x.line_discount + share);
      if (x.kind === 'deposit_balance') {
        x.deposit = r2(Math.min(Number(x.service.deposit_amount || 0), x.net));
        x.balance = r2(x.net - x.deposit);
      }
    });

    // 3. Totals
    const sum = (f) => r2(L.reduce((a, x) => a + f(x), 0));
    const totals = {
      subtotal: sum(x => x.gross),
      discount_total: sum(x => x.discount_amount),
      total: sum(x => x.net),
      one_off_total: sum(x => x.kind === 'one_off' ? x.net : 0),
      deposits_now: sum(x => x.kind === 'deposit_balance' ? x.deposit : 0),
      balance_later: sum(x => x.kind === 'deposit_balance' ? x.balance : 0),
      ongoing_total: sum(x => x.kind === 'ongoing' ? x.net : 0),
    };
    totals.one_off_due_now = r2(totals.one_off_total + totals.deposits_now);

    // 4. Payment schedule for ongoing services
    const start = quote.start_date || todayISO();
    const ye = quote.year_end_date;
    const sched = { start_date: start, year_end_date: ye, payments_left: 0, late_start: false, monthly_allowed: false,
      payments_count: null, monthly_amount: null, monthly_total: null, dates: [], first_payment_date: null, last_payment_date: null };
    if (totals.ongoing_total > 0) {
      if (!ye) errors.push('Set the year end date.');
      else if (ye < start) errors.push('The year end is before the start date.');
      else {
        const natural = paymentDates(start, ye);
        sched.payments_left = natural.length;
        sched.late_start = natural.length <= threshold;
        let n = natural.length, dates = natural;
        if (sched.late_start) {
          const inst = Number(quote.payments_count || 0);
          if (quote.late_start_mode === 'instalments' && inst >= 2) {
            n = inst; dates = Array.from({ length: n }, (_, k) => addMonths(start, k));
          } else n = 0; // single payment
        }
        if (n >= 2) {
          sched.monthly_allowed = true;
          sched.payments_count = n;
          // Round DOWN to the penny so the client never pays more than the quoted total
          sched.monthly_amount = Math.floor(r2(totals.ongoing_total * 100 / n)) / 100;
          sched.monthly_total = r2(sched.monthly_amount * n);
          sched.dates = dates;
          sched.first_payment_date = dates[0];
          sched.last_payment_date = dates[dates.length - 1];
        }
      }
    }

    // 5. What the client pays under each option
    const options = {
      one_off: { due_now: r2(totals.one_off_due_now + totals.ongoing_total), later_monthly: 0, balance_later: totals.balance_later },
      monthly: sched.monthly_allowed ? {
        due_now: r2(totals.one_off_due_now + sched.monthly_amount),
        then: `${sched.payments_count - 1} more monthly payment${sched.payments_count - 1 === 1 ? '' : 's'} of £${sched.monthly_amount.toFixed(2)}`,
        balance_later: totals.balance_later,
      } : null,
    };
    return { lines: L, totals, schedule: sched, options, errors };
  }

  const api = { compute, addMonths, paymentDates, nextTaxYearEnd, taxYearLabel, todayISO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.A4TQuote = api;
})(typeof window !== 'undefined' ? window : globalThis);
