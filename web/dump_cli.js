#!/usr/bin/env node
// Dump the JS engine's result as JSON (used by test_js_parity.py).
// usage: node web/dump_cli.js TXN.csv YYYY-MM-DD [HOLDINGS.csv]
const fs = require("fs");
const F = require("./lotfifo.js");

const [txnPath, asOf, holdPath] = process.argv.slice(2);
try {
  const res = F.runFifo(F.parseIciciCsv(fs.readFileSync(txnPath, "utf8")), F.parseISODate(asOf));
  const out = {
    lots: res.lots, matches: res.matches, summary: F.summarize(res),
    migration: F.migrationEntries(res), migration_trade_price: F.migrationEntries(res, false),
    migration_condensed: F.migrationEntries(res, true, true),
  };
  if (holdPath) out.reconcile = F.reconcile(res, fs.readFileSync(holdPath, "utf8"));
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.name, message: e.message }));
}
