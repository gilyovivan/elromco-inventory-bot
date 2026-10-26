"use strict";
// Local check: node scripts/run-report.js [mode] [--analyze]
// Prints the collected MoveBoard data (and Claude's report with --analyze) without sending to Telegram.
const { getPeriod }     = require("../lib/periods");
const { collectReport } = require("../lib/collect");

async function main() {
  const mode = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "lastweek";
  const period = getPeriod(mode);
  console.error(`Collecting ${mode}: ${period.from} → ${period.to} (prev ${period.prevFrom} → ${period.prevTo})`);

  const data = await collectReport(period);
  console.log(JSON.stringify(data, null, 2));

  if (process.argv.includes("--analyze")) {
    const { analyzeReport } = require("../lib/claude");
    console.log("\n──────── REPORT ────────\n" + await analyzeReport(data, period));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
