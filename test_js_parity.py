"""The browser engine (web/lotfifo.js) must give exactly the same answers as fifo_lots.py.

Runs the JS engine through Node on the same CSVs and compares every lot, match and
summary row. Skipped when node is not installed.
"""
import csv, json, os, random, shutil, subprocess
from datetime import date

import pytest

import fifo_lots as F
from test_fifo_lots import HEADER, random_book

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE, reason="node not installed")
AS_OF = date(2026, 10, 5)


def run_js(txn_csv, as_of=AS_OF, holdings=None):
    args = [NODE, os.path.join(HERE, "web", "dump_cli.js"), txn_csv, as_of.isoformat()]
    if holdings:
        args.append(holdings)
    return json.loads(subprocess.run(args, capture_output=True, text=True, check=True).stdout)


def write_txns(path, txns, remarks_cycle=("icicidirect",)):
    with open(path, "w", newline="", encoding="utf-8") as f:
        f.write(HEADER)
        w = csv.writer(f)
        for i, t in enumerate(txns):
            # split charges across the three columns the parser sums
            b = round(t.charges * 0.7, 2); c = round(t.charges * 0.2, 2); s = round(t.charges - b - c, 2)
            w.writerow([t.symbol, f"{t.symbol} LTD, \"X\"", t.isin, t.action.upper() if i % 3 else t.action,
                        t.qty, repr(t.price), b, c, s, "Rolling", "STT Paid",
                        remarks_cycle[i % len(remarks_cycle)], t.date.strftime("%d-%b-%Y"), "NSE", ""])


def ordinal(d):  # JS day number -> python date
    return date.fromordinal(date(1970, 1, 1).toordinal() + d)


def check_same(py_res, js):
    assert len(js["lots"]) == len(py_res.lots)
    for l, j in zip(py_res.lots, js["lots"]):
        assert (l.lot_id, l.isin, l.symbol, l.buy_row, l.qty_bought, l.qty_remaining, l.status, l.kind) == \
               (j["lot_id"], j["isin"], j["symbol"], j["buy_row"], j["qty_bought"], j["qty_remaining"],
                j["status"], j["kind"])
        assert l.buy_date == ordinal(j["buy_date"])
        assert l.cost_per_share == j["cost_per_share"]          # bit-identical, not approx
        assert [list(x) for x in l.consumed_by] == j["consumed_by"]
    assert len(js["matches"]) == len(py_res.matches)
    for m, j in zip(py_res.matches, js["matches"]):
        assert (m.lot_id, m.sell_row, m.qty, m.term, m.pre_2018, m.holding_days) == \
               (j["lot_id"], j["sell_row"], j["qty"], j["term"], j["pre_2018"], j["holding_days"])
        assert (m.proceeds, m.cost, m.pnl) == (j["proceeds"], j["cost"], j["pnl"])
    for s, j in zip(F.summarize(py_res), js["summary"]):
        for k, v in s.items():
            if k == "earliest_open":
                assert v == (ordinal(j[k]) if j[k] is not None else None)
            else:
                assert v == j[k], k


@pytest.mark.parametrize("seed", range(40))
def test_js_engine_matches_python_on_random_books(tmp_path, seed):
    rng = random.Random(1000 + seed)
    txns = random_book(rng, n_isin=4, n_ev=60)
    p = str(tmp_path / "t.csv")
    write_txns(p, txns, ("icicidirect", "Bonus", "Added from reco", "Demerger-Buy", ""))
    py = F.run_fifo(F.parse_icici_csv(p), as_of=AS_OF)
    check_same(py, run_js(p))


def test_js_reconcile_matches_python(tmp_path):
    txns = random_book(random.Random(7), n_isin=3, n_ev=30)
    p, h = str(tmp_path / "t.csv"), str(tmp_path / "h.csv")
    write_txns(p, txns)
    py = F.run_fifo(F.parse_icici_csv(p), as_of=AS_OF)
    with open(h, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ISIN Code", "Qty", "Value At Cost", "Realized Profit / Loss"])
        for i, s in enumerate(F.summarize(py)[:-1]):        # last ISIN missing on purpose
            w.writerow([s["isin"], f"{s['qty_open']:,}", f"{s['cost_open'] + i:,.2f}",
                        f"({abs(s['realized_pnl']):,.2f})" if s["realized_pnl"] < 0 else s["realized_pnl"]])
    assert F.reconcile(py, h) == run_js(p, holdings=h)["reconcile"]


@pytest.mark.parametrize("row", [
    "A,A,INE1,Hold,1,1,0,0,0,R,S,x,01-Jan-2020,NSE,",
    "A,A,INE1,Buy,0,1,0,0,0,R,S,x,01-Jan-2020,NSE,",
    "A,A,INE1,Buy,1,-1,0,0,0,R,S,x,01-Jan-2020,NSE,",
    "A,A,INE1,Buy,1,1,0,0,0,R,S,x,2020-01-01,NSE,",
    "A,A,INE1,Buy,1,1,0,0,0,R,S,x,31-Feb-2020,NSE,",
    "A,A,,Buy,1,1,0,0,0,R,S,x,01-Jan-2020,NSE,",
    "A,A,INE1,Buy,1.5,1,0,0,0,R,S,x,01-Jan-2020,NSE,",
    "A,A,INE1,Buy,1,,0,0,0,R,S,x,01-Jan-2020,NSE,",
    "A,A,INE1,Sell,1,1,0,0,0,R,S,x,01-Jan-2020,NSE,",          # oversell
])
def test_js_rejects_what_python_rejects(tmp_path, row):
    p = tmp_path / "t.csv"
    p.write_text(HEADER + row + "\n")
    with pytest.raises(F.FifoError):
        F.run_fifo(F.parse_icici_csv(str(p)))
    assert run_js(str(p))["error"] == "FifoError"


def test_js_rejects_missing_columns(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("a,b,c\n1,2,3\n")
    assert "missing columns" in run_js(str(p))["message"]


@pytest.mark.parametrize("buy,sell,expected", [
    ((2024, 1, 15), (2025, 1, 15), "ST"), ((2024, 1, 15), (2025, 1, 16), "LT"),
    ((2024, 2, 29), (2025, 2, 28), "ST"), ((2024, 2, 29), (2025, 3, 1), "LT"),
    ((2023, 3, 31), (2024, 3, 31), "ST"), ((2023, 3, 31), (2024, 4, 1), "LT"),
])
def test_js_long_term_boundary(tmp_path, buy, sell, expected):
    p = tmp_path / "t.csv"
    b, s = date(*buy).strftime("%d-%b-%Y"), date(*sell).strftime("%d-%b-%Y")
    p.write_text(HEADER + f"A,A,INE1,Buy,1,10,0,0,0,R,S,x,{b},NSE,\nA,A,INE1,Sell,1,12,0,0,0,R,S,x,{s},NSE,\n")
    assert run_js(str(p))["matches"][0]["term"] == expected


def test_reconcile_reads_icici_holdings_export_layout(tmp_path):
    """ICICI's own holdings download: Stock Symbol first, extra columns, losses in brackets, trailing comma."""
    txns = random_book(random.Random(11), n_isin=3, n_ev=30)
    p, h = str(tmp_path / "t.csv"), str(tmp_path / "h.csv")
    write_txns(p, txns)
    py = F.run_fifo(F.parse_icici_csv(p), as_of=AS_OF)
    with open(h, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Stock Symbol", "Company Name", "ISIN Code", "Qty", "Average Cost Price", "Current Market Price",
                    "% Change over prev close", "Value At Cost", "Value At Market Price", "Realized Profit / Loss",
                    "Unrealized Profit/Loss", "Unrealized Profit/Loss %", ""])
        for s in F.summarize(py):
            rp = s["realized_pnl"]
            w.writerow([s["symbol"], "X LTD", s["isin"], s["qty_open"], "1.00", "2.00", "- 0.78", f"{s['cost_open']:.2f}",
                        "0", f"({abs(rp):.2f})" if rp < 0 else f"{rp:.2f}", "0", "(1.00)", ""])
    rec = F.reconcile(py, h)
    assert rec and all(r["qty_ok"] and abs(r["realized_diff"]) < 0.01 and abs(r["cost_diff"]) < 0.01 for r in rec)
    assert rec == run_js(p, holdings=h)["reconcile"]
