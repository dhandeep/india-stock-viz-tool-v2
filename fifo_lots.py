"""
FIFO lot tracker for Indian demat equity holdings (built for ICICI Direct
"Portfolio -> Equity -> All Transactions" CSV exports).

Core guarantees (all covered by tests):
  * Lots are consumed strictly oldest-first, per ISIN (never per symbol).
  * A sell larger than the open quantity is an ERROR (no silent short positions).
  * Quantity and cost are conserved: bought == sold + remaining, and
    cost(matched) + cost(remaining) == cost(all lots).
  * Same-date policy: buys are processed before sells on the same date.

Conventions (documented, adjustable):
  * Cost per share = price + (brokerage + transaction charges + stamp duty) / qty.
    STT is not part of the file and is not deductible, so it is ignored.
  * Sale proceeds are net of sell-side brokerage/charges, apportioned by quantity.
  * Long term = held MORE than 12 months (acquisition date + 12 calendar months
    strictly before the sale / as-of date).
  * Zero-price buys are treated as bonus/free-allotment lots: cost 0, acquisition
    date = the date in the file. They are flagged, never silently altered.
"""
from __future__ import annotations

import csv
import dataclasses
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Iterable

from dateutil.relativedelta import relativedelta

GRANDFATHER_CUTOFF = date(2018, 1, 31)  # lots acquired on/before this need FMV-31-Jan-2018


class FifoError(ValueError):
    """Raised for data that would make the FIFO result untrustworthy."""


@dataclass
class Txn:
    row: int                 # 1-based data row number in the source file (for audit)
    symbol: str
    isin: str
    name: str
    action: str              # "Buy" | "Sell"
    qty: int
    price: float
    charges: float           # brokerage + transaction charges + stamp duty
    date: date
    remarks: str = ""
    segment: str = ""
    exchange: str = ""


@dataclass
class Lot:
    lot_id: str
    isin: str
    symbol: str
    name: str
    buy_row: int
    buy_date: date
    qty_bought: int
    price: float
    charges: float
    remarks: str
    kind: str                # BUY | BONUS_OR_FREE | DEMERGER | RECO | 
    qty_remaining: int = 0
    consumed_by: list = field(default_factory=list)  # [(sell_row, qty)]

    @property
    def cost_per_share(self) -> float:
        return self.price + self.charges / self.qty_bought

    @property
    def qty_sold(self) -> int:
        return self.qty_bought - self.qty_remaining

    @property
    def status(self) -> str:
        if self.qty_remaining == 0:
            return "CLOSED"
        if self.qty_remaining == self.qty_bought:
            return "OPEN"
        return "PARTIAL"


@dataclass
class Match:
    isin: str
    symbol: str
    sell_row: int
    sell_date: date
    sell_price: float
    lot_id: str
    buy_row: int
    buy_date: date
    qty: int
    cost_per_share: float
    proceeds: float          # net of apportioned sell-side charges
    cost: float
    pnl: float
    holding_days: int
    term: str                # LT | ST
    pre_2018: bool           # acquired on/before 31-Jan-2018 (grandfathering relevant)


def is_long_term(buy: date, sell: date) -> bool:
    """Listed equity: long term iff held for MORE than 12 months."""
    return sell > buy + relativedelta(months=12)


def classify_kind(t: Txn) -> str:
    r = t.remarks.lower()
    if "demerger" in r:
        return "DEMERGER"
    if "bonus" in r:
        return "BONUS_OR_FREE"
    if t.price == 0:
        return "BONUS_OR_FREE"
    if "reco" in r:
        return "RECO"
    return "BUY"


# ----------------------------------------------------------------- parsing
_REQUIRED = ["Stock Symbol", "Company Name", "ISIN Code", "Action", "Quantity",
             "Transaction Price", "Transaction Date"]


def parse_icici_csv(path: str) -> list[Txn]:
    """Parse the ICICI Direct equity transaction export. Strict: bad rows raise."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        missing = [c for c in _REQUIRED if c not in (rd.fieldnames or [])]
        if missing:
            raise FifoError(f"missing columns: {missing}")
        out = []
        for i, r in enumerate(rd, start=1):
            if not any((v or "").strip() for v in r.values()):
                continue  # blank line
            try:
                action = r["Action"].strip().title()
                if action not in ("Buy", "Sell"):
                    raise FifoError(f"unknown Action {r['Action']!r}")
                qty = int(r["Quantity"])
                if qty <= 0:
                    raise FifoError("quantity must be positive")
                price = float(r["Transaction Price"])
                if price < 0:
                    raise FifoError("negative price")
                d = datetime.strptime(r["Transaction Date"].strip(), "%d-%b-%Y").date()
                charges = sum(float(r.get(k) or 0) for k in
                              ("Brokerage", "Transaction Charges", "StampDuty"))
                isin = r["ISIN Code"].strip()
                if not isin:
                    raise FifoError("empty ISIN")
            except (ValueError, KeyError, FifoError) as e:
                raise FifoError(f"data row {i}: {e}") from e
            out.append(Txn(row=i, symbol=r["Stock Symbol"].strip(), isin=isin,
                           name=r["Company Name"].strip(), action=action, qty=qty,
                           price=price, charges=charges, date=d,
                           remarks=(r.get("Remarks") or "").strip(),
                           segment=(r.get("Segment") or "").strip(),
                           exchange=(r.get("Exchange") or "").strip()))
    return out


# ------------------------------------------------------------------ engine
@dataclass
class Result:
    lots: list[Lot]
    matches: list[Match]
    as_of: date

    def lots_for(self, isin: str) -> list[Lot]:
        return [l for l in self.lots if l.isin == isin]

    def open_lots(self) -> list[Lot]:
        return [l for l in self.lots if l.qty_remaining > 0]


def run_fifo(txns: Iterable[Txn], as_of: date | None = None) -> Result:
    as_of = as_of or date.today()
    by_isin: dict[str, list[Txn]] = {}
    for t in txns:
        by_isin.setdefault(t.isin, []).append(t)

    lots: list[Lot] = []
    matches: list[Match] = []

    for isin, ts in by_isin.items():
        # date asc; same date: Buy before Sell; then original file order (stable)
        ts = sorted(ts, key=lambda t: (t.date, 0 if t.action == "Buy" else 1, t.row))
        queue: list[Lot] = []   # oldest first
        n = 0
        for t in ts:
            if t.action == "Buy":
                n += 1
                lot = Lot(lot_id=f"{isin}-{n:03d}", isin=isin, symbol=t.symbol,
                          name=t.name, buy_row=t.row, buy_date=t.date,
                          qty_bought=t.qty, price=t.price, charges=t.charges,
                          remarks=t.remarks, kind=classify_kind(t),
                          qty_remaining=t.qty)
                queue.append(lot)
                lots.append(lot)
            else:
                need = t.qty
                avail = sum(l.qty_remaining for l in queue)
                if need > avail:
                    raise FifoError(
                        f"{t.symbol} ({isin}) row {t.row}: sell of {need} on {t.date} "
                        f"exceeds open quantity {avail}")
                for lot in queue:
                    if need == 0:
                        break
                    if lot.qty_remaining == 0:
                        continue
                    take = min(need, lot.qty_remaining)
                    lot.qty_remaining -= take
                    lot.consumed_by.append((t.row, take))
                    proceeds = take * t.price - t.charges * take / t.qty
                    cost = take * lot.cost_per_share
                    matches.append(Match(
                        isin=isin, symbol=t.symbol, sell_row=t.row, sell_date=t.date,
                        sell_price=t.price, lot_id=lot.lot_id, buy_row=lot.buy_row,
                        buy_date=lot.buy_date, qty=take,
                        cost_per_share=lot.cost_per_share, proceeds=proceeds,
                        cost=cost, pnl=proceeds - cost,
                        holding_days=(t.date - lot.buy_date).days,
                        term="LT" if is_long_term(lot.buy_date, t.date) else "ST",
                        pre_2018=lot.buy_date <= GRANDFATHER_CUTOFF))
                    need -= take
                # drop fully consumed lots from the front of the queue
                while queue and queue[0].qty_remaining == 0:
                    queue.pop(0)
    lots.sort(key=lambda l: (l.symbol, l.buy_date, l.lot_id))
    return Result(lots=lots, matches=matches, as_of=as_of)


# --------------------------------------------------------------- reporting
def summarize(res: Result) -> list[dict]:
    rows = []
    for isin in sorted({l.isin for l in res.lots}):
        ls = res.lots_for(isin)
        open_ = [l for l in ls if l.qty_remaining > 0]
        qty = sum(l.qty_remaining for l in open_)
        cost = sum(l.qty_remaining * l.cost_per_share for l in open_)
        lt = sum(l.qty_remaining for l in open_ if is_long_term(l.buy_date, res.as_of))
        pre = sum(l.qty_remaining for l in open_ if l.buy_date <= GRANDFATHER_CUTOFF)
        ms = [m for m in res.matches if m.isin == isin]
        rows.append(dict(
            isin=isin, symbol=ls[0].symbol, name=ls[0].name,
            lots_total=len(ls), lots_open=len(open_),
            lots_partial=sum(1 for l in ls if l.status == "PARTIAL"),
            qty_open=qty, cost_open=cost,
            avg_cost_open=(cost / qty if qty else 0.0),
            earliest_open=min((l.buy_date for l in open_), default=None),
            qty_lt=lt, qty_st=qty - lt, qty_pre2018=pre,
            realized_pnl=sum(m.pnl for m in ms),
            flagged_lots=sum(1 for l in ls if l.kind != "BUY")))
    return rows


def migration_entries(res: Result, include_charges: bool = True) -> list[dict]:
    """Open lots as buy-average entries for a new broker: one per (ISIN, buy date).

    Brokers such as Zerodha accept one entry per ISIN per date, so open lots bought on the
    same date are merged: qty = sum of remaining qty, price = weighted average of the per-share
    price (cost incl. charges, or the trade price alone). Bonus lots keep price 0.
    """
    groups: dict = {}
    for l in res.lots:
        if l.qty_remaining == 0:
            continue
        g = groups.get((l.isin, l.buy_date))
        if g is None:
            g = groups[(l.isin, l.buy_date)] = dict(isin=l.isin, symbol=l.symbol, name=l.name,
                                                    date=l.buy_date, qty=0, value=0.0,
                                                    lot_ids=[], kinds=[])
        unit = l.cost_per_share if include_charges else l.price
        g["qty"] += l.qty_remaining
        g["value"] += l.qty_remaining * unit
        g["lot_ids"].append(l.lot_id)
        if l.kind != "BUY" and l.kind not in g["kinds"]:
            g["kinds"].append(l.kind)
    out = sorted(groups.values(), key=lambda g: (g["symbol"], g["isin"], g["date"]))
    for g in out:
        g["price"] = g["value"] / g["qty"]
    return out


def reconcile(res: Result, holdings_csv: str, tol_cost: float = 1.0) -> list[dict]:
    """Compare against ICICI's portfolio export (Qty / Value At Cost / Realized)."""
    with open(holdings_csv, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        hold = {r["ISIN Code"].strip(): r for r in rd if (r.get("ISIN Code") or "").strip()}

    def num(s):
        s = (s or "0").replace(",", "").strip()
        neg = s.startswith("(") and s.endswith(")")
        s = s.strip("()").replace(" ", "")
        return -float(s) if neg else float(s)

    out = []
    for s in summarize(res):
        h = hold.get(s["isin"])
        if not h:
            out.append(dict(isin=s["isin"], symbol=s["symbol"], note="not in holdings file"))
            continue
        q, vc, rp = int(num(h["Qty"])), num(h["Value At Cost"]), num(h["Realized Profit / Loss"])
        out.append(dict(
            isin=s["isin"], symbol=s["symbol"],
            qty_fifo=s["qty_open"], qty_icici=q, qty_ok=s["qty_open"] == q,
            cost_fifo=round(s["cost_open"], 2), cost_icici=vc,
            cost_diff=round(s["cost_open"] - vc, 2),
            cost_ok=abs(s["cost_open"] - vc) <= tol_cost,
            realized_fifo=round(s["realized_pnl"], 2), realized_icici=rp,
            realized_diff=round(s["realized_pnl"] - rp, 2)))
    return out
