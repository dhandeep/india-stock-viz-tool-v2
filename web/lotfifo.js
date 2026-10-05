/*
 * lotfifo.js: FIFO lot engine for ICICI Direct equity exports (browser + Node).
 *
 * A line-for-line port of fifo_lots.py. The arithmetic is kept in the same
 * order as the Python so results are bit-identical; test_js_parity.py checks
 * this on random books. Conventions (same as the Python module):
 *   - FIFO per ISIN (never per symbol); same date: buys before sells; oversell throws.
 *   - Cost/share = price + (brokerage + txn charges + stamp)/qty. STT excluded.
 *   - Sale proceeds net of sell-side charges, apportioned by quantity.
 *   - Long term = held MORE than 12 months.
 *   - Zero-price buys = bonus/free lots (cost 0, date as in file). Flagged, never altered.
 *
 * Dates are integer day numbers (days since 1970-01-01, UTC) so there is no
 * time-zone drift; use fmtDate / parseISODate to convert.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LotFifo = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  class FifoError extends Error {
    constructor(msg) { super(msg); this.name = "FifoError"; }
  }

  // ------------------------------------------------------------------ dates
  function dayNum(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / DAY_MS); }
  function ymd(n) {
    const dt = new Date(n * DAY_MS);
    return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function validDay(y, m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m); }

  /** dateutil relativedelta(months=k): clamp the day to the target month's end. */
  function addMonths(n, k) {
    let [y, m, d] = ymd(n);
    const t = (y * 12 + (m - 1)) + k;
    y = Math.floor(t / 12); m = (t % 12) + 1;
    return dayNum(y, m, Math.min(d, daysInMonth(y, m)));
  }

  function fmtDate(n) {
    if (n == null) return "";
    const [y, m, d] = ymd(n);
    return `${String(d).padStart(2, "0")}-${MONTH_NAMES[m - 1]}-${y}`;
  }
  function isoDate(n) {
    const [y, m, d] = ymd(n);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function parseISODate(s) {
    const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    if (!mt || !validDay(+mt[1], +mt[2], +mt[3])) throw new FifoError(`bad date ${s}`);
    return dayNum(+mt[1], +mt[2], +mt[3]);
  }
  function today() {
    const t = new Date();
    return dayNum(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  /** strptime(s, "%d-%b-%Y") */
  function parseIciciDate(s) {
    const mt = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
    const mi = mt ? MONTHS.indexOf(mt[2].toLowerCase()) : -1;
    if (!mt || mi < 0 || !validDay(+mt[3], mi + 1, +mt[1]))
      throw new FifoError(`time data '${s}' does not match format '%d-%b-%Y'`);
    return dayNum(+mt[3], mi + 1, +mt[1]);
  }

  const GRANDFATHER_CUTOFF = dayNum(2018, 1, 31);

  // -------------------------------------------------------------- numbers
  /** Python int(str) on a decimal string. */
  function pyInt(s) {
    const v = String(s == null ? "" : s).trim().replace(/_/g, "");
    if (!/^[+-]?\d+$/.test(v)) throw new FifoError(`invalid literal for int(): '${s}'`);
    return parseInt(v, 10);
  }
  /** Python float(str) on a decimal string. */
  function pyFloat(s) {
    const v = String(s == null ? "" : s).trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v))
      throw new FifoError(`could not convert string to float: '${s}'`);
    return parseFloat(v);
  }

  // ------------------------------------------------------------------ CSV
  /** RFC 4180 parser (quoted fields, "" escapes, CRLF/LF). Returns array of rows. */
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);  // utf-8-sig
    const rows = [];
    let row = [], f = "", q = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { f += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        f += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ",") { row.push(f); f = ""; i++; continue; }
      if (c === "\r" || c === "\n") {
        row.push(f); rows.push(row); row = []; f = "";
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++; continue;
      }
      f += c; i++;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  /** csv.DictReader: header row -> objects; truly empty lines are skipped. */
  function dictRows(text) {
    const rows = parseCSV(text).filter(r => !(r.length === 1 && r[0] === "") && r.length);
    if (!rows.length) return { fields: [], rows: [] };
    const fields = rows[0];
    const out = rows.slice(1).map(r => {
      const o = {};
      fields.forEach((h, j) => { o[h] = j < r.length ? r[j] : null; });
      return o;
    });
    return { fields, rows: out };
  }

  // -------------------------------------------------------------- parsing
  const REQUIRED = ["Stock Symbol", "Company Name", "ISIN Code", "Action", "Quantity",
    "Transaction Price", "Transaction Date"];

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, p, ch) => p + ch.toUpperCase());
  }
  const str = v => (v == null ? "" : String(v)).trim();

  /** Parse the ICICI Direct equity transaction export text. Strict: bad rows throw. */
  function parseIciciCsv(text) {
    const { fields, rows } = dictRows(text);
    const missing = REQUIRED.filter(c => !fields.includes(c));
    if (missing.length) throw new FifoError(`missing columns: ${JSON.stringify(missing)}`);
    const out = [];
    rows.forEach((r, k) => {
      const i = k + 1;
      if (!Object.values(r).some(v => str(v))) return;  // blank line
      let t;
      try {
        const action = titleCase(str(r["Action"]));
        if (action !== "Buy" && action !== "Sell") throw new FifoError(`unknown Action '${r["Action"]}'`);
        const qty = pyInt(r["Quantity"]);
        if (qty <= 0) throw new FifoError("quantity must be positive");
        const price = pyFloat(r["Transaction Price"]);
        if (price < 0) throw new FifoError("negative price");
        const date = parseIciciDate(str(r["Transaction Date"]));
        let charges = 0;
        for (const key of ["Brokerage", "Transaction Charges", "StampDuty"])
          charges += r[key] ? pyFloat(r[key]) : 0;
        const isin = str(r["ISIN Code"]);
        if (!isin) throw new FifoError("empty ISIN");
        t = {
          row: i, symbol: str(r["Stock Symbol"]), isin, name: str(r["Company Name"]),
          action, qty, price, charges, date, remarks: str(r["Remarks"]),
          segment: str(r["Segment"]), exchange: str(r["Exchange"]),
        };
      } catch (e) {
        throw new FifoError(`data row ${i}: ${e.message}`);
      }
      out.push(t);
    });
    return out;
  }

  // --------------------------------------------------------------- engine
  const isLongTerm = (buy, sell) => sell > addMonths(buy, 12);

  function classifyKind(t) {
    const r = t.remarks.toLowerCase();
    if (r.includes("demerger")) return "DEMERGER";
    if (r.includes("bonus")) return "BONUS_OR_FREE";
    if (t.price === 0) return "BONUS_OR_FREE";
    if (r.includes("reco")) return "RECO";
    return "BUY";
  }

  const costPerShare = l => l.price + l.charges / l.qty_bought;
  const lotStatus = l => l.qty_remaining === 0 ? "CLOSED" : (l.qty_remaining === l.qty_bought ? "OPEN" : "PARTIAL");
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function runFifo(txns, asOf) {
    asOf = asOf == null ? today() : asOf;
    const byIsin = new Map();
    for (const t of txns) {
      if (!byIsin.has(t.isin)) byIsin.set(t.isin, []);
      byIsin.get(t.isin).push(t);
    }
    const lots = [], matches = [];
    for (const [isin, list] of byIsin) {
      // date asc; same date: Buy before Sell; then original file order
      const ts = list.slice().sort((a, b) =>
        (a.date - b.date) || ((a.action === "Buy" ? 0 : 1) - (b.action === "Buy" ? 0 : 1)) || (a.row - b.row));
      const queue = [];
      let n = 0;
      for (const t of ts) {
        if (t.action === "Buy") {
          n++;
          const lot = {
            lot_id: `${isin}-${String(n).padStart(3, "0")}`, isin, symbol: t.symbol, name: t.name,
            buy_row: t.row, buy_date: t.date, qty_bought: t.qty, price: t.price, charges: t.charges,
            remarks: t.remarks, kind: classifyKind(t), qty_remaining: t.qty, consumed_by: [],
          };
          lot.cost_per_share = costPerShare(lot);
          queue.push(lot); lots.push(lot);
        } else {
          let need = t.qty;
          const avail = queue.reduce((s, l) => s + l.qty_remaining, 0);
          if (need > avail)
            throw new FifoError(`${t.symbol} (${isin}) row ${t.row}: sell of ${need} on ${isoDate(t.date)} ` +
              `exceeds open quantity ${avail}`);
          for (const lot of queue) {
            if (need === 0) break;
            if (lot.qty_remaining === 0) continue;
            const take = Math.min(need, lot.qty_remaining);
            lot.qty_remaining -= take;
            lot.consumed_by.push([t.row, take]);
            const proceeds = take * t.price - t.charges * take / t.qty;
            const cost = take * lot.cost_per_share;
            matches.push({
              isin, symbol: t.symbol, sell_row: t.row, sell_date: t.date, sell_price: t.price,
              lot_id: lot.lot_id, buy_row: lot.buy_row, buy_date: lot.buy_date, qty: take,
              cost_per_share: lot.cost_per_share, proceeds, cost, pnl: proceeds - cost,
              holding_days: t.date - lot.buy_date,
              term: isLongTerm(lot.buy_date, t.date) ? "LT" : "ST",
              pre_2018: lot.buy_date <= GRANDFATHER_CUTOFF,
            });
            need -= take;
          }
          while (queue.length && queue[0].qty_remaining === 0) queue.shift();
        }
      }
    }
    for (const l of lots) { l.qty_sold = l.qty_bought - l.qty_remaining; l.status = lotStatus(l); }
    lots.sort((a, b) => cmp(a.symbol, b.symbol) || (a.buy_date - b.buy_date) || cmp(a.lot_id, b.lot_id));
    return { lots, matches, as_of: asOf };
  }

  // ------------------------------------------------------------ reporting
  function summarize(res) {
    const isins = [...new Set(res.lots.map(l => l.isin))].sort(cmp);
    return isins.map(isin => {
      const ls = res.lots.filter(l => l.isin === isin);
      const open = ls.filter(l => l.qty_remaining > 0);
      let qty = 0, cost = 0, lt = 0, pre = 0;
      for (const l of open) qty += l.qty_remaining;
      for (const l of open) cost += l.qty_remaining * l.cost_per_share;
      for (const l of open) if (isLongTerm(l.buy_date, res.as_of)) lt += l.qty_remaining;
      for (const l of open) if (l.buy_date <= GRANDFATHER_CUTOFF) pre += l.qty_remaining;
      let realized = 0;
      for (const m of res.matches) if (m.isin === isin) realized += m.pnl;
      return {
        isin, symbol: ls[0].symbol, name: ls[0].name,
        lots_total: ls.length, lots_open: open.length,
        lots_partial: ls.filter(l => l.status === "PARTIAL").length,
        qty_open: qty, cost_open: cost, avg_cost_open: qty ? cost / qty : 0,
        earliest_open: open.length ? Math.min(...open.map(l => l.buy_date)) : null,
        qty_lt: lt, qty_st: qty - lt, qty_pre2018: pre,
        realized_pnl: realized,
        flagged_lots: ls.filter(l => l.kind !== "BUY").length,
      };
    });
  }

  /**
   * Open lots as buy-average entries for a new broker: one per (ISIN, buy date).
   * Brokers such as Zerodha accept one entry per ISIN per date, so open lots bought on the same
   * date are merged: qty = sum of remaining qty, price = weighted average of the per-share price
   * (cost incl. charges, or the trade price alone). Bonus lots keep price 0.
   */
  function migrationEntries(res, includeCharges = true) {
    const groups = new Map();
    for (const l of res.lots) {
      if (l.qty_remaining === 0) continue;
      const key = l.isin + "|" + l.buy_date;
      let g = groups.get(key);
      if (!g) {
        g = { isin: l.isin, symbol: l.symbol, name: l.name, date: l.buy_date, qty: 0, value: 0, lot_ids: [], kinds: [] };
        groups.set(key, g);
      }
      const unit = includeCharges ? l.cost_per_share : l.price;
      g.qty += l.qty_remaining;
      g.value += l.qty_remaining * unit;
      g.lot_ids.push(l.lot_id);
      if (l.kind !== "BUY" && !g.kinds.includes(l.kind)) g.kinds.push(l.kind);
    }
    const out = [...groups.values()].sort((a, b) => cmp(a.symbol, b.symbol) || cmp(a.isin, b.isin) || (a.date - b.date));
    for (const g of out) g.price = g.value / g.qty;
    return out;
  }

  /** Python round(x, 2): toFixed rounds the exact binary value, as Python does (ties are practically never exact). */
  const round2 = x => Number(x.toFixed(2));

  function holdingsNum(s) {
    s = (s == null || s === "" ? "0" : String(s)).replace(/,/g, "").trim();
    const neg = s.startsWith("(") && s.endsWith(")");
    s = s.replace(/^[()]+|[()]+$/g, "").replace(/ /g, "");
    const v = pyFloat(s);
    return neg ? -v : v;
  }

  /** Compare against ICICI's portfolio export (Qty / Value At Cost / Realized). */
  function reconcile(res, holdingsText, tolCost = 1.0) {
    const hold = new Map();
    for (const r of dictRows(holdingsText).rows) {
      const k = str(r["ISIN Code"]);
      if (k) hold.set(k, r);
    }
    return summarize(res).map(s => {
      const h = hold.get(s.isin);
      if (!h) return { isin: s.isin, symbol: s.symbol, note: "not in holdings file" };
      const q = Math.trunc(holdingsNum(h["Qty"]));
      const vc = holdingsNum(h["Value At Cost"]);
      const rp = holdingsNum(h["Realized Profit / Loss"]);
      return {
        isin: s.isin, symbol: s.symbol,
        qty_fifo: s.qty_open, qty_icici: q, qty_ok: s.qty_open === q,
        cost_fifo: round2(s.cost_open), cost_icici: vc,
        cost_diff: round2(s.cost_open - vc), cost_ok: Math.abs(s.cost_open - vc) <= tolCost,
        realized_fifo: round2(s.realized_pnl), realized_icici: rp,
        realized_diff: round2(s.realized_pnl - rp),
      };
    });
  }

  return {
    FifoError, GRANDFATHER_CUTOFF, parseCSV, parseIciciCsv, runFifo, summarize, reconcile, migrationEntries,
    isLongTerm, classifyKind, addMonths, dayNum, ymd, fmtDate, isoDate, parseISODate,
    parseIciciDate, today,
  };
});
