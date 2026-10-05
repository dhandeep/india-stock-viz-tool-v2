# lotfifo — FIFO cost-basis ledger for ICICI Direct equity exports

Rebuilds a lot-by-lot cost basis (FIFO, per ISIN) from an ICICI Direct transaction export:
what you still hold, when each lot was bought and at what cost, long-term vs short-term,
pre-2018 (grandfathered) lots, realised P&L per sale, and lots that need a manual check.
Useful when moving shares to another broker, which typically shows transferred shares with no buy average.

## Use it

**Online:** https://dhandeep.github.io/india-stock-viz-tool-v2/ (use *Install app*, or the browser's install /
"Add to Home Screen" option, to keep it as an app; once opened it also works offline. Installed on desktop
Chrome/Edge, it can open `.csv` files directly via "Open with").

**From a download:** clone or download this repo and open `web/index.html` (double-click is fine).

1. Open the app.
2. Choose your files (they are read inside the browser tab and never uploaded anywhere):

| File | Required | Where to get it | Columns used |
|---|---|---|---|
| Transactions CSV | yes | ICICI Direct › Portfolio › Equity › All Transactions › download CSV | `Stock Symbol, Company Name, ISIN Code, Action, Quantity, Transaction Price, Transaction Date` (DD-Mon-YYYY); `Brokerage, Transaction Charges, StampDuty, Remarks` if present |
| Holdings CSV | no, for reconciliation | ICICI Direct › Portfolio › Equity (holdings) › download CSV (or fill the app's blank template) | `ISIN Code, Qty, Value At Cost, Realized Profit / Loss`; other columns ignored |

3. Set the **As of** date (defaults to today) and read the tabs: Overview, Summary, Lot Ledger, Open Lots,
   Sell Matches, Flags, Migrate. Every table sorts, filters and downloads as CSV.
4. **Migrate** lists what to enter at the new broker (e.g. Zerodha Console's buy-average update for transferred
   holdings): one entry per stock per buy date with quantity and price (cost incl. charges, or trade price only).
   Open lots bought on the same date are merged at their weighted average, since brokers accept one entry per date;
   lots from different dates are never merged, so holding periods (long/short term) stay exact.

"Load sample data" uses synthetic data from `web/sample/` (fake companies and ISINs).

## Rules

FIFO per ISIN; same-day buys before sells; a sell larger than the open quantity is an error.
Cost/share = price + (brokerage + transaction charges + stamp duty) / qty (STT excluded); sale proceeds
net of sell charges. Long term = held more than 12 months. Zero-price buys are bonus/free lots (cost 0) and flagged.
Not handled: splits, consolidations, mergers. Not tax advice; verify flagged lots against corporate-action records.

## Development

    pip install python-dateutil pytest
    python -m pytest -q        # Python engine tests + JS parity tests (parity needs node)

`fifo_lots.py` is the reference engine; `web/lotfifo.js` is a port of it, and `test_js_parity.py`
requires both to produce identical lots, matches, summaries and reconciliation on random books.
To check against your own exports locally (never commit them):
`LOTFIFO_TXN=path/to/txns.csv LOTFIFO_HOLDINGS=path/to/holdings.csv python -m pytest -q -k real_export`
