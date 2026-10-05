import os, random, csv, textwrap
from datetime import date
import pytest
import fifo_lots as F

D = date
# Optional check against your own exports (never commit them): set both env vars to run it.
REAL_TXN = os.environ.get("LOTFIFO_TXN", "")
REAL_HOLD = os.environ.get("LOTFIFO_HOLDINGS", "")


def T(row, action, qty, price, d, charges=0.0, isin="INE000A01010", sym="XYZ", remarks=""):
    return F.Txn(row=row, symbol=sym, isin=isin, name=sym, action=action, qty=qty,
                 price=price, charges=charges, date=d, remarks=remarks)


# ---------------------------------------------------------------- basic FIFO
def test_sell_consumes_oldest_lot_first_and_leaves_partial():
    res = F.run_fifo([T(1, "Buy", 10, 100, D(2020, 1, 1)),
                      T(2, "Buy", 10, 200, D(2020, 6, 1)),
                      T(3, "Sell", 15, 300, D(2021, 12, 1))], as_of=D(2022, 1, 1))
    l1, l2 = res.lots_for("INE000A01010")
    assert (l1.qty_remaining, l1.status) == (0, "CLOSED")
    assert (l2.qty_remaining, l2.status) == (5, "PARTIAL")
    # 10 @100 and 5 @200 consumed; proceeds 15*300
    assert sum(m.pnl for m in res.matches) == pytest.approx(15 * 300 - (10 * 100 + 5 * 200))
    assert [(m.lot_id[-3:], m.qty) for m in res.matches] == [("001", 10), ("002", 5)]


def test_sell_exactly_depletes_multiple_lots():
    res = F.run_fifo([T(1, "Buy", 5, 10, D(2020, 1, 1)), T(2, "Buy", 5, 20, D(2020, 1, 2)),
                      T(3, "Buy", 5, 30, D(2020, 1, 3)), T(4, "Sell", 15, 50, D(2020, 2, 1))])
    assert all(l.status == "CLOSED" for l in res.lots)
    assert res.open_lots() == []


def test_multiple_sells_continue_from_partial_lot():
    res = F.run_fifo([T(1, "Buy", 10, 100, D(2020, 1, 1)),
                      T(2, "Sell", 3, 150, D(2020, 2, 1)),
                      T(3, "Sell", 4, 160, D(2020, 3, 1))])
    (lot,) = res.lots
    assert lot.qty_remaining == 3 and lot.consumed_by == [(2, 3), (3, 4)]


def test_oversell_raises_not_silently_ignored():
    with pytest.raises(F.FifoError, match="exceeds open quantity"):
        F.run_fifo([T(1, "Buy", 5, 10, D(2020, 1, 1)), T(2, "Sell", 6, 12, D(2020, 2, 1))])


def test_sell_before_any_buy_raises():
    with pytest.raises(F.FifoError):
        F.run_fifo([T(1, "Sell", 1, 10, D(2020, 1, 1)), T(2, "Buy", 1, 10, D(2020, 2, 1))])


def test_isins_are_independent_even_if_symbol_collides():
    res = F.run_fifo([T(1, "Buy", 5, 10, D(2020, 1, 1), isin="A"),
                      T(2, "Buy", 5, 10, D(2020, 1, 1), isin="B"),
                      T(3, "Sell", 5, 20, D(2020, 2, 1), isin="A")])
    assert [l.qty_remaining for l in res.lots_for("A")] == [0]
    assert [l.qty_remaining for l in res.lots_for("B")] == [5]


def test_file_order_does_not_matter_only_dates():
    rows = [T(1, "Buy", 10, 100, D(2020, 1, 1)), T(2, "Buy", 10, 200, D(2020, 6, 1)),
            T(3, "Sell", 15, 300, D(2021, 12, 1))]
    a = F.run_fifo(rows)
    b = F.run_fifo(list(reversed(rows)))
    assert [(m.buy_date, m.qty) for m in a.matches] == [(m.buy_date, m.qty) for m in b.matches]


def test_same_day_buy_is_processed_before_sell():
    res = F.run_fifo([T(1, "Sell", 5, 12, D(2020, 1, 1)), T(2, "Buy", 5, 10, D(2020, 1, 1))])
    assert res.lots[0].status == "CLOSED"


# -------------------------------------------------------------- cost & P&L
def test_charges_are_added_to_cost_and_deducted_from_proceeds():
    res = F.run_fifo([T(1, "Buy", 10, 100, D(2020, 1, 1), charges=10),
                      T(2, "Sell", 5, 120, D(2020, 6, 1), charges=6)])
    (m,) = res.matches
    assert m.cost_per_share == pytest.approx(101.0)           # 100 + 10/10
    assert m.cost == pytest.approx(505.0)
    assert m.proceeds == pytest.approx(5 * 120 - 6 * 5 / 5)    # all 6 of sell charges (5 of 5)
    assert m.pnl == pytest.approx(600 - 6 - 505)


def test_sell_charges_apportioned_across_lots_by_quantity():
    res = F.run_fifo([T(1, "Buy", 4, 10, D(2020, 1, 1)), T(2, "Buy", 6, 10, D(2020, 1, 2)),
                      T(3, "Sell", 10, 20, D(2020, 3, 1), charges=10)])
    assert sum(m.proceeds for m in res.matches) == pytest.approx(10 * 20 - 10)
    assert [round(m.proceeds, 2) for m in res.matches] == [76.0, 114.0]


def test_zero_price_buy_is_bonus_lot_with_zero_cost_and_own_date():
    res = F.run_fifo([T(1, "Buy", 100, 50, D(2015, 1, 1)),
                      T(2, "Buy", 100, 0, D(2016, 1, 1)),
                      T(3, "Sell", 150, 80, D(2017, 6, 1))])
    bonus = res.lots[1]
    assert bonus.kind == "BONUS_OR_FREE" and bonus.cost_per_share == 0
    # 100 @50 then 50 @0 consumed
    assert sum(m.cost for m in res.matches) == pytest.approx(5000)


def test_remarks_classification():
    assert F.classify_kind(T(1, "Buy", 1, 5, D(2020, 1, 1), remarks="Demerger-Buy")) == "DEMERGER"
    assert F.classify_kind(T(1, "Buy", 1, 1, D(2020, 1, 1), remarks="Added from reco")) == "RECO"
    assert F.classify_kind(T(1, "Buy", 1, 0, D(2020, 1, 1), remarks="Bonus")) == "BONUS_OR_FREE"
    assert F.classify_kind(T(1, "Buy", 1, 9, D(2020, 1, 1), remarks="icicidirect")) == "BUY"


# ------------------------------------------------------------ LT / ST rules
@pytest.mark.parametrize("buy,sell,expected", [
    (D(2024, 1, 15), D(2025, 1, 15), False),   # exactly 12 months -> short term
    (D(2024, 1, 15), D(2025, 1, 16), True),    # one day more -> long term
    (D(2024, 1, 15), D(2024, 12, 31), False),
    (D(2024, 2, 29), D(2025, 2, 28), False),   # leap-day buy: 12 months ends 28-Feb-2025
    (D(2024, 2, 29), D(2025, 3, 1), True),
])
def test_long_term_boundary(buy, sell, expected):
    assert F.is_long_term(buy, sell) is expected


def test_match_term_and_pre2018_flag():
    res = F.run_fifo([T(1, "Buy", 1, 10, D(2017, 5, 1)), T(2, "Buy", 1, 10, D(2024, 1, 1)),
                      T(3, "Sell", 2, 20, D(2024, 6, 1))])
    m1, m2 = res.matches
    assert (m1.term, m1.pre_2018) == ("LT", True)
    assert (m2.term, m2.pre_2018) == ("ST", False)


def test_summary_lt_st_split_uses_as_of_date():
    ts = [T(1, "Buy", 10, 10, D(2025, 7, 22)), T(2, "Buy", 5, 10, D(2020, 1, 1))]
    s = F.summarize(F.run_fifo(ts, as_of=D(2026, 7, 22)))[0]
    assert (s["qty_lt"], s["qty_st"]) == (5, 10)     # 22-Jul-2026 is exactly 12 months -> still ST
    s = F.summarize(F.run_fifo(ts, as_of=D(2026, 7, 23)))[0]
    assert (s["qty_lt"], s["qty_st"]) == (15, 0)


# ------------------------------------------------- broker migration entries
def test_migration_merges_same_date_open_lots_at_weighted_average():
    res = F.run_fifo([T(1, "Buy", 10, 100, D(2020, 1, 1), charges=10),       # cps 101
                      T(2, "Buy", 30, 120, D(2020, 1, 1), charges=0),        # same date -> merged
                      T(3, "Buy", 5, 0, D(2021, 1, 1), remarks="Bonus"),     # bonus: price 0
                      T(4, "Buy", 8, 90, D(2022, 1, 1))])
    e = F.migration_entries(res)
    assert [(x["date"], x["qty"]) for x in e] == [(D(2020, 1, 1), 40), (D(2021, 1, 1), 5), (D(2022, 1, 1), 8)]
    assert e[0]["price"] == pytest.approx((10 * 101 + 30 * 120) / 40)
    assert e[1]["price"] == 0 and e[1]["kinds"] == ["BONUS_OR_FREE"]
    assert F.migration_entries(res, include_charges=False)[0]["price"] == pytest.approx((10 * 100 + 30 * 120) / 40)


def test_migration_uses_only_remaining_qty_and_skips_closed_lots():
    res = F.run_fifo([T(1, "Buy", 10, 100, D(2020, 1, 1)), T(2, "Buy", 10, 200, D(2020, 6, 1)),
                      T(3, "Sell", 15, 300, D(2021, 12, 1))])
    (e,) = F.migration_entries(res)                     # lot 1 closed, lot 2 has 5 left
    assert (e["date"], e["qty"], e["price"], e["lot_ids"]) == (D(2020, 6, 1), 5, 200, ["INE000A01010-002"])


@pytest.mark.parametrize("seed", range(30))
def test_migration_entries_add_up_to_holdings(seed):
    txns = random_book(random.Random(seed))
    res = F.run_fifo(txns, as_of=date(2026, 10, 5))
    e = F.migration_entries(res)
    assert len({(x["isin"], x["date"]) for x in e}) == len(e)          # one entry per ISIN per date
    for s in F.summarize(res):
        mine = [x for x in e if x["isin"] == s["isin"]]
        assert sum(x["qty"] for x in mine) == s["qty_open"]
        assert sum(x["value"] for x in mine) == pytest.approx(s["cost_open"])


def test_condensed_migration_keeps_tax_buckets_apart():
    ts = [T(1, "Buy", 10, 100, D(2015, 1, 1)), T(2, "Buy", 10, 200, D(2017, 6, 1)),    # pre-2018
          T(3, "Buy", 5, 0, D(2017, 9, 1), remarks="Bonus"),                            # pre-2018 bonus
          T(4, "Buy", 10, 300, D(2019, 1, 1)), T(5, "Buy", 10, 400, D(2020, 1, 1)),    # later long-term
          T(6, "Buy", 4, 500, D(2026, 6, 1)),                                           # short-term
          T(7, "Buy", 3, 1, D(2016, 3, 1), remarks="Added from reco"),                  # kept separate
          T(8, "Sell", 5, 250, D(2018, 6, 1))]                                          # FIFO: from 2015 lot
    e = F.migration_entries(F.run_fifo(ts, as_of=D(2026, 10, 5)), condensed=True)
    got = [(x["bucket"], x["date"], x["qty"]) for x in e]
    assert got == [("lot", D(2016, 3, 1), 3), ("pre2018", D(2017, 9, 1), 20),
                   ("lt", D(2020, 1, 1), 20), ("st", D(2026, 6, 1), 4)]
    pre = e[1]
    assert pre["first_date"] == D(2015, 1, 1)
    assert pre["price"] == pytest.approx((5 * 100 + 10 * 200 + 5 * 0) / 20)
    assert pre["date"] <= F.GRANDFATHER_CUTOFF


@pytest.mark.parametrize("seed", range(30))
def test_condensed_migration_preserves_totals_and_boundaries(seed):
    res = F.run_fifo(random_book(random.Random(seed)), as_of=date(2026, 10, 5))
    exact, cond = F.migration_entries(res), F.migration_entries(res, condensed=True)
    assert len(cond) <= len(exact)
    for s in F.summarize(res):
        mine = [x for x in cond if x["isin"] == s["isin"]]
        assert sum(x["qty"] for x in mine) == s["qty_open"]
        assert sum(x["value"] for x in mine) == pytest.approx(s["cost_open"])
        assert sum(x["qty"] for x in mine if x["date"] <= F.GRANDFATHER_CUTOFF) == s["qty_pre2018"]
        assert sum(x["qty"] for x in mine if F.is_long_term(x["date"], res.as_of)) == s["qty_lt"]


# -------------------- independent reference + randomised invariants (the key one)
def reference_share_queue(txns):
    """Deliberately naive and structurally different: one list entry per SHARE,
    pop from the front. Returns {isin: sorted remaining (buy_date, cost_per_share) multiset}."""
    out = {}
    by = {}
    for t in txns:
        by.setdefault(t.isin, []).append(t)
    for isin, ts in by.items():
        ts = sorted(ts, key=lambda t: (t.date, 0 if t.action == "Buy" else 1, t.row))
        shares = []
        for t in ts:
            if t.action == "Buy":
                shares += [(t.date, round(t.price + t.charges / t.qty, 9))] * t.qty
            else:
                del shares[:t.qty]
        out[isin] = sorted(shares)
    return out


def random_book(rng, n_isin=3, n_ev=40):
    txns, row = [], 0
    for k in range(n_isin):
        isin, held, d = f"ISIN{k}", 0, date(2015, 1, 1)
        for _ in range(n_ev):
            d = date.fromordinal(d.toordinal() + rng.randint(0, 120))
            row += 1
            if held == 0 or rng.random() < 0.6:
                q = rng.randint(1, 50)
                txns.append(T(row, "Buy", q, rng.choice([0, 0, 10, 55.5, 120]), d,
                              charges=round(rng.random() * 5, 2), isin=isin, sym=isin))
                held += q
            else:
                q = rng.randint(1, held)
                txns.append(T(row, "Sell", q, rng.uniform(5, 200), d,
                              charges=round(rng.random() * 5, 2), isin=isin, sym=isin))
                held -= q
    return txns


@pytest.mark.parametrize("seed", range(200))
def test_random_books_match_reference_and_hold_invariants(seed):
    rng = random.Random(seed)
    txns = random_book(rng)
    res = F.run_fifo(txns, as_of=date(2026, 10, 5))

    # 1) agrees with independent per-share implementation
    ref = reference_share_queue(txns)
    for isin, expected in ref.items():
        got = sorted([(l.buy_date, round(l.cost_per_share, 9))
                      for l in res.lots_for(isin) for _ in range(l.qty_remaining)])
        assert got == expected

    # 2) quantity conservation
    for isin in ref:
        b = sum(t.qty for t in txns if t.isin == isin and t.action == "Buy")
        s = sum(t.qty for t in txns if t.isin == isin and t.action == "Sell")
        assert sum(l.qty_remaining for l in res.lots_for(isin)) == b - s
        assert sum(m.qty for m in res.matches if m.isin == isin) == s

    # 3) cost conservation
    for isin in ref:
        allc = sum(l.qty_bought * l.cost_per_share for l in res.lots_for(isin))
        mc = sum(m.cost for m in res.matches if m.isin == isin)
        rc = sum(l.qty_remaining * l.cost_per_share for l in res.lots_for(isin))
        assert mc + rc == pytest.approx(allc)

    # 4) THE FIFO invariant: in date order, closed lots, then at most one partial, then untouched
    for isin in ref:
        order = sorted(res.lots_for(isin), key=lambda l: (l.buy_date, l.lot_id))
        states = [l.status for l in order]
        first_non_closed = next((i for i, s in enumerate(states) if s != "CLOSED"), len(states))
        tail = states[first_non_closed:]
        assert all(s != "CLOSED" for s in tail), f"gap in FIFO order: {states}"
        assert tail.count("PARTIAL") <= 1
        if "PARTIAL" in tail:
            assert tail[0] == "PARTIAL"

    # 5) no lot is ever consumed before it was bought
    assert all(m.sell_date >= m.buy_date for m in res.matches)


# ------------------------------------------------------------------ parsing
HEADER = ("Stock Symbol,Company Name,ISIN Code,Action,Quantity,Transaction Price,Brokerage,"
          "Transaction Charges,StampDuty,Segment,STT Paid/Not Paid,Remarks,Transaction Date,"
          "Exchange,\n")


def write(tmp_path, body):
    p = tmp_path / "t.csv"
    p.write_text(HEADER + textwrap.dedent(body).lstrip(), encoding="utf-8")
    return str(p)


def test_parse_icici_format_with_trailing_empty_column(tmp_path):
    p = write(tmp_path, """\
        ACME,ACME INDUSTRIES LTD,INE000X01011,Buy,150,70.25,60.10,0.35,1.05,Rolling,STT Paid,icicidirect,22-Jul-2013,NSE,
        ACME,ACME INDUSTRIES LTD,INE000X01011,Sell,50,100.00,10,0.1,0,Rolling,STT Paid,icicidirect,22-Jul-2014,NSE,
        """)
    t = F.parse_icici_csv(p)
    assert len(t) == 2 and t[0].date == D(2013, 7, 22)
    assert t[0].charges == pytest.approx(60.10 + 0.35 + 1.05)


@pytest.mark.parametrize("row", [
    "A,A,INE1,Hold,1,1,0,0,0,R,S,x,01-Jan-2020,NSE,",     # unknown action
    "A,A,INE1,Buy,0,1,0,0,0,R,S,x,01-Jan-2020,NSE,",      # zero qty
    "A,A,INE1,Buy,1,-1,0,0,0,R,S,x,01-Jan-2020,NSE,",     # negative price
    "A,A,INE1,Buy,1,1,0,0,0,R,S,x,2020-01-01,NSE,",       # wrong date format
    "A,A,,Buy,1,1,0,0,0,R,S,x,01-Jan-2020,NSE,",          # empty ISIN
])
def test_parse_rejects_bad_rows(tmp_path, row):
    with pytest.raises(F.FifoError):
        F.parse_icici_csv(write(tmp_path, row + "\n"))


def test_parse_rejects_missing_columns(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("a,b,c\n1,2,3\n")
    with pytest.raises(F.FifoError, match="missing columns"):
        F.parse_icici_csv(str(p))


# -------------------------------------- integration on the real export (if present)
@pytest.mark.skipif(not (REAL_TXN and REAL_HOLD and os.path.exists(REAL_TXN) and os.path.exists(REAL_HOLD)),
                    reason="set LOTFIFO_TXN and LOTFIFO_HOLDINGS to your exports to run")
def test_real_export_reconciles_to_icici_holdings():
    res = F.run_fifo(F.parse_icici_csv(REAL_TXN))
    rec = F.reconcile(res, REAL_HOLD)
    assert rec and all("note" not in r for r in rec)                       # every ISIN is in the holdings file
    assert all(r["qty_ok"] for r in rec)                                   # quantities exact
    assert abs(sum(r["realized_diff"] for r in rec)) < 1.0                 # realised P&L ~exact
    assert all(abs(r["realized_diff"]) < 1.0 for r in rec)                 # ...per ISIN too
    total_cost_icici = sum(r["cost_icici"] for r in rec)
    assert abs(sum(r["cost_diff"] for r in rec)) / total_cost_icici < 0.0005   # <0.05% overall
    assert all(abs(r["cost_diff"]) < 150 for r in rec)                     # each ISIN within Rs150
