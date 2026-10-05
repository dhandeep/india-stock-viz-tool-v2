/* app.js: UI for the FIFO lot ledger. Reads local CSVs, runs lotfifo.js, renders tabs. */
(function () {
  "use strict";
  const F = window.LotFifo;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const NOTE = {
    RECO: "Placeholder lot added by ICICI during reconciliation. Price/date may not be the true acquisition " +
      "price/date. Verify against the original corporate action or purchase.",
    DEMERGER: "Lot created from a demerger. Verify cost against the company's disclosed cost-apportionment " +
      "ratio and that the date is the PARENT shares' purchase date.",
    BONUS_OR_FREE: "Zero cost (bonus/free allotment). Acquisition date = allotment date as given in the file; " +
      "verify against the corporate action record.",
  };

  // ------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem("lotfifo:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("lotfifo:" + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // --------------------------------------------------------- formatting
  const nf2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const money = v => (v == null || v === "" ? "" : nf2.format(v));
  const qty = v => (v == null || v === "" ? "" : nf0.format(v));
  const date = v => (v == null ? "" : F.fmtDate(v));
  function compact(v) {
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
    return `${s}₹${nf0.format(a)}`;
  }
  const rupee = v => (v < 0 ? "−₹" : "₹") + nf2.format(Math.abs(v));
  /** Share as a percent, never rounding a non-zero remainder up to 100% or down to 0%. */
  const pct = (a, b) => {
    const p = a / b * 100;
    if (a < b && p >= 99.5) return Math.min(p, 99.9).toFixed(1) + "%";
    if (a > 0 && p < 0.5) return Math.max(p, 0.1).toFixed(1) + "%";
    return Math.round(p) + "%";
  };
  const signed = v => `<span class="${v < 0 ? "bad" : ""}">${money(v)}</span>`;

  // -------------------------------------------------------------- state
  const S = {
    txnText: null, txnName: "", holdText: null, holdName: "",
    asOf: store.get("asOf", null), tab: store.get("tab", "overview"),
    symbol: null, fmv: store.get("fmv", {}),
    res: null, summ: [], rec: null, recBy: new Map(), extraHoldings: [],
  };

  // ------------------------------------------------------------ loading
  function readFile(file) {
    return new Promise((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(r.result); r.onerror = () => bad(r.error);
      r.readAsText(file);
    });
  }
  const looksLikeHoldings = text => /^﻿?[^\n]*ISIN Code/.test(text) && /Value At Cost/.test(text.split(/\r?\n/, 1)[0]);

  /** Holdings rows as {isin, symbol}, found by column name: ICICI's own export has Stock Symbol first. */
  function holdingsEntries(text) {
    const rows = F.parseCSV(text);
    const head = (rows[0] || []).map(h => h.trim());
    const iIsin = head.indexOf("ISIN Code"), iSym = head.indexOf("Stock Symbol");
    if (iIsin < 0) return [];
    return rows.slice(1).map(r => ({ isin: (r[iIsin] || "").trim(), symbol: iSym < 0 ? "" : (r[iSym] || "").trim() }))
      .filter(e => e.isin);
  }

  const looksLikeTxns = text => /Transaction Date/.test(text.split(/\r?\n/, 1)[0]);
  const fileErr = { txn: null, hold: null };

  async function loadFiles(files, forceKind) {
    const hadData = !!S.res;
    for (const f of files) {
      const text = await readFile(f);
      const kind = forceKind || (looksLikeHoldings(text) ? "hold" : "txn");
      // catch the common mix-up of choosing the wrong file for a step
      if (kind === "txn" && looksLikeHoldings(text)) { fileErr.txn = `${f.name} looks like a holdings file; choose it in step 2.`; continue; }
      if (kind === "hold" && looksLikeTxns(text)) { fileErr.hold = `${f.name} looks like a transactions file; choose it in step 1.`; continue; }
      fileErr[kind] = null;
      if (kind === "hold") { S.holdText = text; S.holdName = f.name; }
      else { S.txnText = text; S.txnName = f.name; }
    }
    recompute();
    if (!hadData && S.res && !S.holdText) setTab("files");      // first file in: offer step 2 before results
    else if (!hadData && S.res) setTab("overview");
  }

  function loadSample() {
    const d = window.LOTFIFO_SAMPLE;
    if (!d) return showMessages([{ type: "error", html: "Sample data file <code>sample/sample_data.js</code> is missing." }]);
    S.txnText = d.transactions; S.txnName = "sample_transactions.csv (synthetic)";
    S.holdText = d.holdings; S.holdName = "sample_holdings.csv (synthetic)";
    fileErr.txn = fileErr.hold = null;
    recompute();
    setTab("overview");
  }

  function downloadTemplate() {
    const blob = new Blob(["ISIN Code,Qty,Value At Cost,Realized Profit / Loss\r\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "holdings_template.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Per-step status on the Files screen and file names in the header. */
  function updateFileStatus(txnErr, holdErr) {
    const set = (kind, cls, text) => {
      const el = $(`[data-status="${kind}"]`);
      el.className = "status " + cls; el.textContent = text;
      $(`[data-step="${kind}"]`).classList.toggle("done", cls === "ok");
    };
    const txnMsg = fileErr.txn || txnErr;
    if (txnMsg) set("txn", "err", "✗ " + txnMsg);
    else if (S.res) set("txn", "ok", `✓ ${S.txnName}: ${S.txns.length} transactions, ${S.summ.length} stocks`);
    else set("txn", "", "Not loaded");
    const holdMsg = fileErr.hold || holdErr;
    if (holdMsg) set("hold", "err", "✗ " + holdMsg);
    else if (S.holdText != null && S.rec) set("hold", "ok", `✓ ${S.holdName}: ${holdingsEntries(S.holdText).length} stocks`);
    else if (S.holdText != null) set("hold", "", `${S.holdName} loaded; checked once the transactions file loads`);
    else set("hold", "", "Not loaded (optional)");
    document.querySelectorAll('[data-name="txn"]').forEach(e => { e.textContent = S.txnName || "required"; });
    document.querySelectorAll('[data-name="hold"]').forEach(e => { e.textContent = S.holdName || "optional"; });
    $("#viewBtn").hidden = !S.res;
  }

  // ------------------------------------------------------------ compute
  function recompute() {
    const msgs = [];
    let txnErr = null, holdErr = null;
    S.res = null;
    if (S.txnText != null) {
      try {
        const asOf = S.asOf ? F.parseISODate(S.asOf) : F.today();
        const txns = F.parseIciciCsv(S.txnText);
        S.txns = txns;
        S.remarks = new Map(txns.map(t => [t.row, t.remarks]));
        S.res = F.runFifo(txns, asOf);
        S.summ = F.summarize(S.res);
        S.rec = null; S.recBy = new Map(); S.extraHoldings = [];
        if (S.holdText != null) {
          try {
            S.rec = F.reconcile(S.res, S.holdText);
            S.recBy = new Map(S.rec.map(r => [r.isin, r]));
            const known = new Set(S.summ.map(s => s.isin));
            S.extraHoldings = holdingsEntries(S.holdText).filter(e => !known.has(e.isin))
              .map(e => (e.symbol ? `${e.symbol} (${e.isin})` : e.isin));
          } catch (e) {
            holdErr = e.message;
            msgs.push({ type: "error", html: `<b>Holdings file could not be read:</b> ${esc(e.message)}` });
          }
        }
        if (S.symbol && !S.summ.some(s => s.symbol === S.symbol)) S.symbol = null;
      } catch (e) {
        txnErr = e.message;
        msgs.push({
          type: "error", html: `<b>Could not build the ledger from ${esc(S.txnName)}.</b> ${esc(e.message)}` +
            (e.name === "FifoError" ? "" : " (unexpected error, see console)"),
        });
        if (e.name !== "FifoError") console.error(e);
      }
    }
    if (S.rec) {
      const bad = S.rec.filter(r => r.note || !r.qty_ok);
      if (bad.length) msgs.push({
        type: "warn", html: `<b>Reconciliation:</b> ${bad.length} ISIN(s) do not match ICICI's quantity or are missing ` +
          `from the holdings file: ${bad.map(r => esc(r.symbol)).join(", ")}.`,
      });
      if (S.extraHoldings.length) msgs.push({
        type: "warn", html: `<b>Holdings file has ${S.extraHoldings.length} ISIN(s) with no transactions:</b> ` +
          `${S.extraHoldings.map(esc).join(", ")}.`,
      });
    }
    showMessages(msgs);
    updateFileStatus(txnErr, holdErr);
    render();
  }

  function showMessages(msgs) {
    $("#messages").innerHTML = msgs.map(m => `<div class="msg ${m.type}">${m.html}</div>`).join("");
  }

  // ---------------------------------------------------------- derived
  const asOf = () => S.res.as_of;
  const termAsOf = l => (F.isLongTerm(l.buy_date, asOf()) ? "LT" : "ST");
  const pre2018 = d => d <= F.GRANDFATHER_CUTOFF;
  const bySymbol = rows => (S.symbol ? rows.filter(r => r.symbol === S.symbol) : rows);
  const flagged = () => S.res.lots.filter(l => l.kind !== "BUY");
  const openLots = () => S.res.lots.filter(l => l.qty_remaining > 0);
  const sortedMatches = () => S.res.matches.slice().sort((a, b) =>
    (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) || (a.sell_date - b.sell_date) ||
    (a.sell_row - b.sell_row) || (a.buy_date - b.buy_date));

  // ------------------------------------------------------------ render
  function render() {
    const has = !!S.res;
    $("#tabs").hidden = !has;
    document.querySelectorAll("section.panel").forEach(p => { p.hidden = true; });
    if (!has || S.tab === "files") {
      $("#panel-files").hidden = false;
      document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === "files"));
      return;
    }
    document.documentElement.style.setProperty("--hdr-h", $("#hdr").offsetHeight + "px");

    const counts = {
      summary: S.summ.length, ledger: S.res.lots.length, open: openLots().length,
      matches: S.res.matches.length, flags: flagged().length,
    };
    document.querySelectorAll("[data-count]").forEach(el => { el.textContent = counts[el.dataset.count]; });
    document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
    const panel = $("#panel-" + S.tab);
    panel.hidden = false;
    ({ overview: renderOverview, summary: renderSummary, ledger: renderLedger, open: renderOpen,
      matches: renderMatches, flags: renderFlags, about: renderAbout })[S.tab](panel);
  }

  function setTab(t) { S.tab = t; store.set("tab", t); render(); window.scrollTo(0, 0); }
  function filterSymbol(sym, tab) { S.symbol = sym; setTab(tab || S.tab); }

  // ---------------------------------------------------------- tables
  const sortState = {};

  /**
   * cols: [{key, label, num, val(row) -> raw value (sort/CSV), html(row) -> cell HTML, cls}]
   * opts: {id, rows, rowClass(row), foot(rows) -> {key: html}, filename, symbolFilter, legend}
   */
  function table(el, cols, opts) {
    const st = sortState[opts.id] || (sortState[opts.id] = { key: null, desc: false, q: "" });
    const val = (c, r) => (c.val ? c.val(r) : r[c.key]);
    let rows = opts.symbolFilter ? bySymbol(opts.rows) : opts.rows;
    if (st.q) {
      const q = st.q.toLowerCase();
      rows = rows.filter(r => cols.some(c => String(c.text ? c.text(r) : val(c, r) ?? "").toLowerCase().includes(q)));
    }
    if (st.key) {
      const c = cols.find(c => c.key === st.key);
      rows = rows.slice().sort((a, b) => {
        const x = val(c, a), y = val(c, b);
        const r = x == null || x === "" ? 1 : y == null || y === "" ? -1 : (x < y ? -1 : x > y ? 1 : 0);
        return st.desc && x != null && y != null && x !== "" && y !== "" ? -r : r;
      });
    }
    const chip = opts.symbolFilter && S.symbol
      ? `<span class="chip">Stock: <b>${esc(S.symbol)}</b><button type="button" data-clear title="Show all">×</button></span>` : "";
    const foot = opts.foot ? opts.foot(rows) : null;
    el.innerHTML = `
      <div class="table-tools">
        <span class="info">${rows.length} of ${opts.rows.length} rows${opts.legend ? " · " + opts.legend : ""}</span>
        ${chip}
        <input type="search" placeholder="Filter rows…" value="${esc(st.q)}" data-q>
        <button class="btn" type="button" data-csv>Download CSV</button>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr>${cols.map(c => `<th data-k="${c.key}" class="${c.num ? "num" : ""} ${st.key === c.key ? "sorted" + (st.desc ? " desc" : "") : ""}"
          ${c.title ? `title="${esc(c.title)}"` : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(r => `<tr class="${opts.rowClass ? opts.rowClass(r) : ""}">${cols.map(c =>
          `<td class="${c.num ? "num" : ""} ${c.cls || ""}">${c.html ? c.html(r) : esc(val(c, r))}</td>`).join("")}</tr>`).join("")}</tbody>
        ${foot ? `<tfoot><tr>${cols.map(c => `<td class="${c.num ? "num" : ""}">${foot[c.key] ?? ""}</td>`).join("")}</tr></tfoot>` : ""}
      </table></div>`;

    el.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (st.key === k) { if (st.desc) st.key = null; else st.desc = true; } else { st.key = k; st.desc = false; }
      table(el, cols, opts);
    }));
    const q = el.querySelector("[data-q]");
    q.addEventListener("input", () => {
      st.q = q.value; table(el, cols, opts);
      const nq = el.querySelector("[data-q]"); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length);
    });
    el.querySelector("[data-csv]").addEventListener("click", () => downloadCSV(opts.filename, cols, rows));
    const clr = el.querySelector("[data-clear]");
    if (clr) clr.addEventListener("click", () => { S.symbol = null; render(); });
    el.querySelectorAll("[data-sym]").forEach(a => a.addEventListener("click", () => filterSymbol(a.dataset.sym, a.dataset.go)));
    if (opts.after) opts.after(el);
  }

  function downloadCSV(name, cols, rows) {
    const cell = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map(c => cell(c.label)).join(",")].concat(rows.map(r => cols.map(c => {
      const v = c.csv ? c.csv(r) : (c.val ? c.val(r) : r[c.key]);
      return cell(c.date ? (v == null ? "" : F.isoDate(v)) : (typeof v === "number" && !Number.isInteger(v) ? +v.toFixed(6) : v));
    }).join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}_asof_${F.isoDate(asOf())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // column helpers
  const symCol = (go) => ({ key: "symbol", label: "Symbol", html: r => `<span class="sym" data-sym="${esc(r.symbol)}" data-go="${go}">${esc(r.symbol)}</span>` });
  const D = (key, label, extra) => Object.assign({ key, label, date: true, html: r => date(r[key]) }, extra);
  const Q = (key, label, extra) => Object.assign({ key, label, num: true, html: r => qty(r[key]) }, extra);
  const M = (key, label, extra) => Object.assign({ key, label, num: true, html: r => money(r[key]) }, extra);
  const kindCell = r => `<span class="kind ${r.kind !== "BUY" ? "flag" : ""}">${esc(r.kind)}</span>`;
  const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);

  // -------------------------------------------------------- Summary
  function renderSummary(el) {
    const rec = s => S.recBy.get(s.isin) || {};
    const has = !!S.rec;
    const diff = (k, fmt, tol) => r => {
      const v = rec(r)[k];
      if (v == null) return "";
      const ok = Math.abs(v) <= tol;
      return `<span class="${ok ? "" : "bad"}" title="${ok ? "matches" : "differs"}">${ok ? "" : "✗ "}${fmt(v)}</span>`;
    };
    const cols = [
      symCol("ledger"), { key: "isin", label: "ISIN" }, { key: "name", label: "Company" },
      Q("qty_open", "Qty held"), M("cost_open", "Cost held"), M("avg_cost_open", "Avg cost"),
      D("earliest_open", "Earliest open lot"), Q("qty_lt", "LT qty"), Q("qty_st", "ST qty"),
      Q("qty_pre2018", "Qty pre-2018", { title: "Acquired on/before 31-Jan-2018: grandfathering applies" }),
      Q("lots_total", "Lots (all)"), Q("lots_partial", "Lots partly sold"),
      { key: "realized_pnl", label: "Realised P&L (FIFO)", num: true, html: r => signed(r.realized_pnl) },
    ];
    if (has) cols.push(
      Q("qty_icici", "ICICI qty", { val: r => rec(r).qty_icici, html: r => qty(rec(r).qty_icici) }),
      M("cost_icici", "ICICI value at cost", { val: r => rec(r).cost_icici, html: r => money(rec(r).cost_icici) }),
      M("realized_icici", "ICICI realised P&L", { val: r => rec(r).realized_icici, html: r => money(rec(r).realized_icici) }),
      { key: "qty_diff", label: "Qty diff", num: true, val: r => (rec(r).qty_icici == null ? null : r.qty_open - rec(r).qty_icici),
        html: r => (rec(r).note ? `<span class="bad">✗ not in holdings</span>` : rec(r).qty_icici == null ? "" : qtyDiff(r)) },
      { key: "cost_diff", label: "Cost diff", num: true, val: r => rec(r).cost_diff, html: diff("cost_diff", money, 150),
        title: "FIFO cost minus ICICI value at cost. A few rupees is rounding in ICICI's charge allocation; ✗ above ₹150." },
      { key: "realized_diff", label: "Realised diff", num: true, val: r => rec(r).realized_diff, html: diff("realized_diff", money, 1) },
    );
    cols.push({
      key: "fmv", label: "FMV 31-Jan-2018 (enter)", num: true, val: r => S.fmv[r.isin] ?? null,
      title: "Fair market value per share on 31-Jan-2018, for grandfathering pre-2018 lots. Saved in this browser.",
      html: r => r.qty_pre2018 > 0
        ? `<input class="fmv" inputmode="decimal" data-isin="${esc(r.isin)}" value="${esc(S.fmv[r.isin] ?? "")}" placeholder="—">` : "",
    });
    function qtyDiff(r) {
      const d = r.qty_open - rec(r).qty_icici;
      return `<span class="${d ? "bad" : "ok"}">${d ? "✗ " + qty(d) : "✓ 0"}</span>`;
    }
    table(el, cols, {
      id: "summary", rows: S.summ, filename: "summary",
      legend: has ? "✗ = differs from ICICI's portfolio export" : "load a Holdings CSV to reconcile with ICICI",
      foot: rows => ({
        symbol: "TOTAL",
        qty_open: qty(sum(rows, r => r.qty_open)), cost_open: money(sum(rows, r => r.cost_open)),
        qty_lt: qty(sum(rows, r => r.qty_lt)), qty_st: qty(sum(rows, r => r.qty_st)),
        qty_pre2018: qty(sum(rows, r => r.qty_pre2018)), lots_total: qty(sum(rows, r => r.lots_total)),
        lots_partial: qty(sum(rows, r => r.lots_partial)), realized_pnl: signed(sum(rows, r => r.realized_pnl)),
        qty_icici: has ? qty(sum(rows, r => rec(r).qty_icici)) : "",
        cost_icici: has ? money(sum(rows, r => rec(r).cost_icici)) : "",
        realized_icici: has ? money(sum(rows, r => rec(r).realized_icici)) : "",
        qty_diff: has ? qty(sum(rows, r => rec(r).qty_icici == null ? 0 : r.qty_open - rec(r).qty_icici)) : "",
        cost_diff: has ? money(sum(rows, r => rec(r).cost_diff)) : "",
        realized_diff: has ? money(sum(rows, r => rec(r).realized_diff)) : "",
      }),
      after: wrap => wrap.querySelectorAll("input.fmv").forEach(inp => inp.addEventListener("change", () => {
        const v = inp.value.trim().replace(/,/g, "");
        if (v === "") delete S.fmv[inp.dataset.isin];
        else if (isFinite(+v) && +v >= 0) S.fmv[inp.dataset.isin] = +v;
        else { inp.value = S.fmv[inp.dataset.isin] ?? ""; return; }
        store.set("fmv", S.fmv);
      })),
    });
  }

  // ----------------------------------------------------- Lot Ledger
  function renderLedger(el) {
    const cols = [
      { key: "lot_id", label: "Lot ID" }, symCol("ledger"), { key: "isin", label: "ISIN" },
      Q("buy_row", "Source row"), D("buy_date", "Buy date"), { key: "kind", label: "Kind", html: kindCell },
      Q("qty_bought", "Qty bought"), Q("qty_sold", "Qty sold (FIFO)"), Q("qty_remaining", "Qty remaining"),
      { key: "status", label: "Status" }, M("price", "Price"), M("charges", "Charges"), M("cost_per_share", "Cost / share"),
      M("remaining_cost", "Remaining cost", { val: r => r.qty_remaining * r.cost_per_share, html: r => money(r.qty_remaining * r.cost_per_share) }),
      Q("days", "Days held (as-of)", { val: r => asOf() - r.buy_date, html: r => qty(asOf() - r.buy_date) }),
      { key: "term", label: "Term (as-of)", val: termAsOf },
      Q("lt_rem", "LT qty remaining", { val: r => (termAsOf(r) === "LT" ? r.qty_remaining : 0), html: r => qty(termAsOf(r) === "LT" ? r.qty_remaining : 0) }),
      Q("st_rem", "ST qty remaining", { val: r => (termAsOf(r) === "ST" ? r.qty_remaining : 0), html: r => qty(termAsOf(r) === "ST" ? r.qty_remaining : 0) }),
      { key: "pre", label: "Pre-2018", val: r => (pre2018(r.buy_date) ? "Y" : "") },
      { key: "consumed", label: "Consumed by sell rows (row:qty)", val: r => r.consumed_by.map(([a, b]) => `${a}:${b}`).join("; "), cls: "wrap" },
      { key: "remarks", label: "Source remarks" },
    ];
    table(el, cols, {
      id: "ledger", rows: S.res.lots, filename: "lot_ledger", symbolFilter: true,
      rowClass: r => r.status.toLowerCase(),
      legend: "struck-through = fully sold · highlighted = partly sold",
      foot: rows => ({
        lot_id: "TOTAL", qty_bought: qty(sum(rows, r => r.qty_bought)), qty_sold: qty(sum(rows, r => r.qty_sold)),
        qty_remaining: qty(sum(rows, r => r.qty_remaining)),
        remaining_cost: money(sum(rows, r => r.qty_remaining * r.cost_per_share)),
      }),
    });
  }

  // ------------------------------------------------------ Open Lots
  function renderOpen(el) {
    const cols = [
      symCol("open"), { key: "isin", label: "ISIN" }, { key: "lot_id", label: "Lot ID" }, D("buy_date", "Buy date"),
      { key: "kind", label: "Kind", html: kindCell }, Q("qty_remaining", "Qty remaining"), { key: "status", label: "Status" },
      M("cost_per_share", "Cost / share"),
      M("remaining_cost", "Remaining cost", { val: r => r.qty_remaining * r.cost_per_share, html: r => money(r.qty_remaining * r.cost_per_share) }),
      { key: "term", label: "Term (as-of)", val: termAsOf }, { key: "pre", label: "Pre-2018", val: r => (pre2018(r.buy_date) ? "Y" : "") },
      { key: "remarks", label: "Source remarks" },
    ];
    table(el, cols, {
      id: "open", rows: openLots(), filename: "open_lots", symbolFilter: true,
      rowClass: r => (r.status === "PARTIAL" ? "partial" : ""),
      legend: "the per-lot cost basis to keep for your new broker and tax filing · highlighted = partly sold",
      foot: rows => ({
        symbol: "TOTAL", qty_remaining: qty(sum(rows, r => r.qty_remaining)),
        remaining_cost: money(sum(rows, r => r.qty_remaining * r.cost_per_share)),
      }),
    });
  }

  // --------------------------------------------------- Sell Matches
  function renderMatches(el) {
    const cols = [
      Q("sell_row", "Sell row"), D("sell_date", "Sell date"), symCol("matches"), { key: "isin", label: "ISIN" },
      M("sell_price", "Sell price"), { key: "lot_id", label: "Lot ID" }, D("buy_date", "Buy date"), Q("qty", "Qty"),
      M("cost_per_share", "Cost / share"), M("proceeds", "Proceeds (net of sell charges)"), M("cost", "Cost"),
      { key: "pnl", label: "P&L", num: true, html: r => signed(r.pnl) }, Q("holding_days", "Days held"),
      { key: "term", label: "Term" }, { key: "pre", label: "Pre-2018", val: r => (r.pre_2018 ? "Y" : "") },
    ];
    table(el, cols, {
      id: "matches", rows: sortedMatches(), filename: "sell_matches", symbolFilter: true,
      legend: "each sell matched to the lots it consumed, oldest first",
      foot: rows => ({
        sell_row: "TOTAL", qty: qty(sum(rows, r => r.qty)), proceeds: money(sum(rows, r => r.proceeds)),
        cost: money(sum(rows, r => r.cost)), pnl: signed(sum(rows, r => r.pnl)),
      }),
    });
  }

  // ---------------------------------------------------------- Flags
  function renderFlags(el) {
    const cols = [
      symCol("flags"), { key: "isin", label: "ISIN" }, { key: "lot_id", label: "Lot ID" }, D("buy_date", "Buy date"),
      { key: "kind", label: "Kind", html: kindCell }, Q("qty_bought", "Qty bought"), Q("qty_remaining", "Qty remaining"),
      M("price", "Price in file"), { key: "verify", label: "What to verify", val: r => NOTE[r.kind], cls: "wrap" },
    ];
    table(el, cols, {
      id: "flags", rows: flagged(), filename: "flags", symbolFilter: true,
      legend: "lots that are not ordinary purchases and need a human check",
    });
  }

  // ---------------------------------------------------------- About
  function renderAbout(el) {
    el.innerHTML = `<div class="about">
      <h3>Files</h3>
      <dl><dt>Transactions</dt><dd>${esc(S.txnName)} (${S.txns.length} transactions)</dd>
          <dt>Holdings</dt><dd>${S.holdName ? esc(S.holdName) : "not loaded"}</dd>
          <dt>As-of date</dt><dd>${date(asOf())}. Drives days held, LT/ST split of open lots, and CSV file names.</dd></dl>
      <h3>How to read</h3>
      <dl>
        <dt>Overview</dt><dd>Totals and charts. Click a bar to open that stock's lots.</dd>
        <dt>Summary</dt><dd>Per-ISIN totals and reconciliation to ICICI's own portfolio export. Click a symbol to see its lots.
          Enter FMV on 31-Jan-2018 for stocks with pre-2018 lots; values are saved in this browser only.</dd>
        <dt>Lot Ledger</dt><dd>Every purchase lot. Struck through = fully sold. Highlighted = partly sold (remaining qty shown). Plain = untouched.</dd>
        <dt>Open Lots</dt><dd>Only what you still hold, lot by lot: this is the cost-basis record to keep for your new broker and your tax filing.</dd>
        <dt>Sell Matches</dt><dd>Each sell row matched to the exact lots it consumed (oldest first), with cost, proceeds, P&amp;L and LT/ST.</dd>
        <dt>Flags</dt><dd>Lots that are not ordinary purchases (reco placeholders, demergers, bonus/free) and need a human check.</dd>
      </dl>
      <h3>Conventions</h3>
      <dl>
        <dt>Matching</dt><dd>FIFO per ISIN, by acquisition date. Same-date: buys processed before sells. A sell larger than open qty is an error, never ignored.</dd>
        <dt>Cost per share</dt><dd>Price + (brokerage + transaction charges + stamp duty) / qty. STT excluded. Sale proceeds are net of sell-side charges.</dd>
        <dt>Long term</dt><dd>Listed equity held MORE than 12 months (acquisition date + 12 calendar months strictly before the sale/as-of date).</dd>
        <dt>Zero-price buys</dt><dd>Treated as bonus/free lots: cost 0, acquisition date as given in the file. Flagged, not altered.</dd>
        <dt>Pre-2018 lots</dt><dd>Acquired on/before 31-Jan-2018. Long-term gains on these use the grandfathered cost (higher of actual cost and
          lower of FMV on 31-Jan-2018 and sale price). FMV is not in the file: enter it on Summary if needed.</dd>
        <dt>Not handled</dt><dd>Splits/consolidations/mergers are not adjusted: quantities and prices are trusted as exported.
          Quantities reconciling to ICICI holdings is the check that none were missed.</dd>
        <dt>Privacy</dt><dd>Files are read in the browser with FileReader. Nothing is uploaded; the page makes no network requests.</dd>
      </dl></div>`;
  }

  // ------------------------------------------------------- Overview
  function renderOverview(el) {
    const s = S.summ, ms = S.res.matches, open = openLots();
    const tot = (f) => sum(s, f);
    const held = s.filter(r => r.qty_open > 0);
    const ltPnl = sum(ms.filter(m => m.term === "LT"), m => m.pnl), stPnl = sum(ms.filter(m => m.term === "ST"), m => m.pnl);
    const qOpen = tot(r => r.qty_open), qLt = tot(r => r.qty_lt);
    const kpis = [
      ["Cost held", compact(tot(r => r.cost_open)), `${qty(qOpen)} shares in ${held.length} stocks`],
      ["Realised P&L (FIFO)", compact(ltPnl + stPnl), `LT ${compact(ltPnl)} · ST ${compact(stPnl)}`],
      ["Long-term as of " + date(asOf()), qOpen ? pct(qLt, qOpen) : "–",
        `${qty(qLt)} LT · ${qty(qOpen - qLt)} ST shares`],
      ["Pre-2018 shares", qty(tot(r => r.qty_pre2018)), "acquired on/before 31-Jan-2018"],
      ["Lots", qty(S.res.lots.length), `${open.length} open · ${S.res.lots.filter(l => l.status === "PARTIAL").length} partly sold · ${ms.length} sell matches`],
      ["Flagged lots", qty(flagged().length), "reco / demerger / bonus: verify"],
    ];
    if (S.rec) {
      const ok = S.rec.filter(r => r.qty_ok).length;
      const cd = sum(S.rec, r => r.cost_diff || 0), rd = sum(S.rec, r => r.realized_diff || 0);
      kpis.push(["Qty matches ICICI", `<span class="${ok === S.rec.length ? "ok" : "bad"}">${ok === S.rec.length ? "✓" : "✗"} ${ok}/${S.rec.length}</span>`,
        `cost diff ${rupee(cd)} · realised diff ${rupee(rd)}`]);
    }
    el.innerHTML = `
      <div class="kpis">${kpis.map(([l, v, sub]) => `<div class="kpi"><div class="label">${esc(l)}</div>
        <div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join("")}</div>
      <div class="charts">
        <div class="card"><h3>Cost held by stock</h3><p class="note">Remaining FIFO cost of open lots, ₹. Click a bar for its lots.</p><div id="c-cost"></div></div>
        <div class="card"><h3>Realised P&amp;L by stock</h3><p class="note">FIFO, net of charges, ₹. Click a bar for its sell matches.</p><div id="c-pnl"></div></div>
        <div class="card wide"><h3>Open cost by acquisition year</h3><p class="note">When the shares you still hold were bought, split by term as of ${date(asOf())}.</p><div id="c-year"></div></div>
      </div>`;

    hbar($("#c-cost"), held.slice().sort((a, b) => b.cost_open - a.cost_open).map(r => ({
      label: r.symbol, value: r.cost_open,
      tip: [r.name, ["Qty held", qty(r.qty_open)], ["Cost held", "₹" + money(r.cost_open)], ["Avg cost", "₹" + money(r.avg_cost_open)],
        ["Earliest lot", date(r.earliest_open)]],
      onClick: () => filterSymbol(r.symbol, "open"),
    })));
    const pnl = s.filter(r => ms.some(m => m.isin === r.isin));
    if (pnl.length) hbar($("#c-pnl"), pnl.slice().sort((a, b) => b.realized_pnl - a.realized_pnl).map(r => {
      const mm = ms.filter(m => m.isin === r.isin);
      return {
        label: r.symbol, value: r.realized_pnl,
        tip: [r.name, ["Realised P&L", "₹" + money(r.realized_pnl)], ["Shares sold", qty(sum(mm, m => m.qty))],
          ["Proceeds", "₹" + money(sum(mm, m => m.proceeds))], ["Cost", "₹" + money(sum(mm, m => m.cost))]],
        onClick: () => filterSymbol(r.symbol, "matches"),
      };
    }), true);
    else $("#c-pnl").innerHTML = `<p class="note">No sells in this file.</p>`;

    const years = new Map();
    for (const l of open) {
      const y = F.ymd(l.buy_date)[0];
      const e = years.get(y) || { lt: 0, st: 0, q: 0, n: 0 };
      e[termAsOf(l) === "LT" ? "lt" : "st"] += l.qty_remaining * l.cost_per_share;
      e.q += l.qty_remaining; e.n++;
      years.set(y, e);
    }
    if (years.size) {
      const ys = [...years.keys()], y0 = Math.min(...ys), y1 = Math.max(...ys);
      const data = [];
      for (let y = y0; y <= y1; y++) data.push({ label: String(y), ...(years.get(y) || { lt: 0, st: 0, q: 0, n: 0 }) });
      vstack($("#c-year"), data);
    }
  }

  // ---------------------------------------------------------- charts
  const tip = $("#tip");
  function tipHTML(t) {
    const [title, ...rows] = t;
    return `<b>${esc(title)}</b>` + rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  }
  function bindTips(svg, items) {
    svg.querySelectorAll("[data-i]").forEach(h => {
      const it = items[+h.dataset.i];
      h.addEventListener("mousemove", e => {
        tip.innerHTML = tipHTML(it.tip); tip.style.display = "block";
        const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
        const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
        tip.style.left = x + "px"; tip.style.top = y + "px";
      });
      h.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      if (it.onClick) h.addEventListener("click", () => { tip.style.display = "none"; it.onClick(); });
    });
  }
  function niceTicks(max, n = 4) {
    if (max <= 0) return [0];
    const raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
    const t = [];
    for (let v = 0; v <= max + step * 1e-9; v += step) t.push(v);
    if (t[t.length - 1] < max) t.push(t[t.length - 1] + step);
    return t;
  }
  const short = v => {
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e7) return s + +(a / 1e7).toFixed(1) + "Cr";
    if (a >= 1e5) return s + +(a / 1e5).toFixed(1) + "L";
    if (a >= 1e3) return s + +(a / 1e3).toFixed(1) + "k";
    return s + Math.round(a);
  };

  /** Horizontal bars, one row per item. diverging: bars grow left/right from zero. */
  function hbar(el, items, diverging) {
    const W = Math.max(300, el.clientWidth || 440), rowH = 22, top = 22, left = 80, right = 44, H = top + items.length * rowH + 6;
    const lo = diverging ? Math.min(0, ...items.map(d => d.value)) : 0;
    const hi = Math.max(0, ...items.map(d => d.value));
    // one tick step across both signs, so negative and positive ticks share spacing
    const span = niceTicks(hi - lo), step = span[1] || 1;
    const min = Math.floor(lo / step) * step, max = Math.max(step, Math.ceil(hi / step) * step);
    const x = v => left + (v - min) / (max - min) * (W - left - right);
    const ticks = [];
    for (let k = Math.round(min / step); k <= Math.round(max / step); k++) ticks.push(k * step);
    let g = ticks.map(t => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 6}"/>
      <text x="${x(t)}" y="${top - 9}" text-anchor="middle">${short(t)}</text>`).join("");
    items.forEach((d, i) => {
      const y = top + i * rowH, bh = rowH - 6, x0 = x(0), x1 = x(d.value);
      const bx = Math.min(x0, x1), bw = Math.max(1, Math.abs(x1 - x0));
      const cls = diverging ? (d.value < 0 ? "bar neg" : "bar pos") : "bar";
      const neg = d.value < 0;
      g += `<rect class="hit" data-i="${i}" x="0" y="${y}" width="${W}" height="${rowH}" rx="3"/>
        <text class="lbl" x="${left - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" pointer-events="none">${esc(d.label)}</text>
        <path class="${cls}" pointer-events="none" d="${barPath(bx, y + 3, bw, bh, neg ? "left" : "right")}"/>
        <text x="${neg ? bx - 4 : bx + bw + 4}" y="${y + rowH / 2 + 4}" text-anchor="${neg ? "end" : "start"}" pointer-events="none">${short(d.value)}</text>`;
    });
    g += `<line class="base" x1="${x(0)}" x2="${x(0)}" y1="${top - 4}" y2="${H - 6}"/>`;
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="bar chart">${g}</svg>`;
    bindTips(el.querySelector("svg"), items);
  }
  /** Bar with 4px rounded data-end, square at the baseline. */
  function barPath(x, y, w, h, end) {
    const r = Math.min(4, w / 2, h / 2);
    if (end === "right") return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
    if (end === "left") return `M${x + w},${y}h-${w - r}a${r},${r} 0 0 0 -${r},${r}v${h - 2 * r}a${r},${r} 0 0 0 ${r},${r}h${w - r}z`;
    // top
    return `M${x},${y + h}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
  }

  /** Vertical stacked bars (LT under ST) per year. */
  function vstack(el, data) {
    const W = Math.max(300, el.clientWidth || 1000), H = 240, top = 12, bottom = 26, left = 52, right = 8;
    const max = Math.max(...data.map(d => d.lt + d.st));
    const ticks = niceTicks(max), ymax = ticks[ticks.length - 1] || 1;
    const y = v => top + (1 - v / ymax) * (H - top - bottom);
    const bwAll = (W - left - right) / data.length, bw = Math.min(46, bwAll * 0.7);
    let g = ticks.map(t => `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/>
      <text x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${short(t)}</text>`).join("");
    const every = Math.ceil(data.length / Math.max(2, Math.floor((W - left - right) / 44)));  // ~44px per year label
    data.forEach((d, i) => {
      const cx = left + bwAll * i + bwAll / 2, x0 = cx - bw / 2;
      const hl = y(0) - y(d.lt), hs = y(0) - y(d.st);
      g += `<rect class="hit" data-i="${i}" x="${cx - bwAll / 2}" y="${top}" width="${bwAll}" height="${H - top - bottom}" rx="3"/>`;
      if (d.lt > 0) g += hs > 0
        ? `<rect pointer-events="none" style="fill:var(--accent)" x="${x0}" y="${y(d.lt)}" width="${bw}" height="${hl}"/>`
        : `<path pointer-events="none" style="fill:var(--accent)" d="${barPath(x0, y(d.lt), bw, hl, "top")}"/>`;
      if (d.st > 0) g += `<path pointer-events="none" style="fill:var(--st)" d="${barPath(x0, y(d.lt + d.st), bw, Math.max(1, hs - (d.lt > 0 ? 2 : 0)), "top")}"/>`;
      if (i % every === 0) g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${d.label}</text>`;
    });
    g += `<line class="base" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>`;
    el.innerHTML = `<div class="legend"><span><i style="background:var(--accent)"></i>Long-term</span>
      <span><i style="background:var(--st)"></i>Short-term</span></div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="open cost by acquisition year">${g}</svg>`;
    bindTips(el.querySelector("svg"), data.map(d => ({
      tip: [d.label, ["Open cost", "₹" + money(d.lt + d.st)], ["Long-term", "₹" + money(d.lt)], ["Short-term", "₹" + money(d.st)],
        ["Shares", qty(d.q)], ["Lots", qty(d.n)]],
    })));
  }

  // ---------------------------------------------------------- wiring
  document.querySelectorAll("input[type=file][data-kind]").forEach(inp => inp.addEventListener("change", e => {
    if (e.target.files.length) loadFiles([...e.target.files], inp.dataset.kind);
    e.target.value = "";
  }));
  $("#sampleLink").addEventListener("click", loadSample);
  $("#templateBtn").addEventListener("click", downloadTemplate);
  $("#viewBtn").addEventListener("click", () => setTab("overview"));
  const asOfInputs = document.querySelectorAll("input.asof");
  asOfInputs.forEach(inp => {
    inp.value = S.asOf || F.isoDate(F.today());
    inp.addEventListener("change", () => {
      S.asOf = inp.value || null; store.set("asOf", S.asOf);
      asOfInputs.forEach(o => { o.value = inp.value; });
      if (S.txnText != null) recompute();
    });
  });
  $("#tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });

  ["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $("#panel-files").classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $("#panel-files").classList.remove("over"); }));
  document.addEventListener("drop", e => { if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files]); });
  let resizeTimer, lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    document.documentElement.style.setProperty("--hdr-h", $("#hdr").offsetHeight + "px");
    clearTimeout(resizeTimer);
    // charts are drawn at the container's pixel width so text stays 11px; redraw when it changes
    resizeTimer = setTimeout(() => { if (S.res && S.tab === "overview" && window.innerWidth !== lastW) { lastW = window.innerWidth; render(); } }, 150);
  });
  // ------------------------------------------------------ installable app
  // Offline cache + install prompt only when served over http(s); opening the file from disk still works.
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker not registered:", e));
  }
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
  $("#installBtn").addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null; $("#installBtn").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; });
  // Installed app opened with CSV files from the OS ("Open with"): load them like dropped files.
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async params => {
      if (!params.files || !params.files.length) return;
      loadFiles(await Promise.all(params.files.map(h => h.getFile())));
    });
  }

  updateFileStatus();
  render();
})();
