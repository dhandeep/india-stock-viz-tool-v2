# Project: FIFO cost-basis ledger from ICICI Direct equity transaction exports

## Why this exists
When shares move out of an ICICI Direct demat (e.g. closure-cum-transfer to another broker), the
receiving broker usually shows the buy average as N/A for transferred shares. This tool rebuilds a
lot-level cost basis (with acquisition dates) from ICICI's transaction history using FIFO, so it can
be kept for tax filing and entered at the new broker.

## Layout
- fifo_lots.py       engine: parse_icici_csv, run_fifo, summarize, reconcile, migration_entries (stdlib + python-dateutil)
- web/index.html     browser app: choose the CSVs, see Summary / Lot Ledger / Open Lots / Sell Matches / Flags / Migrate + charts.
                     Open from disk; files are read locally, no network.
- web/lotfifo.js     JS port of fifo_lots.py (browser + Node). web/app.js = UI, web/dump_cli.js = JSON dump for tests
- web/manifest.webmanifest, web/sw.js, web/icons/   installable PWA: offline app-shell cache (bump VERSION in
                     sw.js when the file list changes; user CSVs are never fetched or cached)
- index.html, .nojekyll   GitHub Pages root: redirects to web/ (site: dhandeep.github.io/india-stock-viz-tool-v2/)
- web/sample/        SYNTHETIC sample CSVs (fake companies/ISINs) + sample_data.js (same data embedded for file:// use)
- test_fifo_lots.py  engine tests (incl. independent per-share reference impl + random invariant tests)
- test_js_parity.py  JS engine must match the Python engine exactly (needs node; skipped otherwise)

## Personal data: never commit it
This repo is public. Real exports, holdings files, account numbers, real company/ISIN rows copied from
an export, and real portfolio figures must not be committed (not in code, tests, docs or commit messages).
.gitignore blocks CSVs outside web/sample/. Tests use synthetic data only; the optional real-data test
reads paths from LOTFIFO_TXN / LOTFIFO_HOLDINGS.

## Commands
    pip install python-dateutil pytest
    python -m pytest -q
    LOTFIFO_TXN=~/exports/txns.csv LOTFIFO_HOLDINGS=~/exports/holdings.csv python -m pytest -q -k real_export

## Rules for changing the engine
- FIFO per ISIN (never per symbol). Same-date: buys before sells. Oversell must raise, never be ignored.
- Cost/share = price + (brokerage + txn charges + stamp)/qty; STT excluded. Long-term = held MORE than 12 months.
- Zero-price buys = bonus/free lots (cost 0, acquisition date as in file). Flag, never silently alter.
- Engine changes go in BOTH fifo_lots.py and web/lotfifo.js (same arithmetic order); test_js_parity.py enforces it.
- Any change to these conventions needs a test change in the same commit. Run the mutation idea
  (swap to LIFO, flip same-day order, drop partial remainder) to confirm tests still catch it.

## Known limitations
- "Added from reco" placeholder lots and demerger lots carry ICICI's figures; real cost/date must come
  from corporate-action records (cost apportionment ratio; parent's purchase date). Shown on Flags.
- Bonus/free lots use the allotment date in the file; verify against corporate actions.
- Grandfathering needs FMV on 31-Jan-2018 per ISIN for pre-2018 lots; entered by the user on Summary.
- Migration entries merge open lots per (ISIN, buy date) because brokers accept one entry per date; a bonus
  and a paid buy on the same date therefore share an averaged price (flagged in the Migrate tab).
- Splits/consolidations/mergers are not adjusted (quantity reconciliation is the check that none were missed).
