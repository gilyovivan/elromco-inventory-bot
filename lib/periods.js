"use strict";
// Report periods on the branch's calendar (America/Los_Angeles), as YYYY-MM-DD.
const TZ = "America/Los_Angeles";

const MODES = {
  today:     "📅 Today",
  yesterday: "📅 Yesterday",
  thisweek:  "📅 This Week",
  lastweek:  "⬅️ Last Week",
  week:      "📅 Last 7 Days",
  month:     "📆 This Month",
  lastmonth: "⬅️ Last Month",
};

function todayInTz() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
}

const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);
const daysBetween = (a, b) => Math.round((b - a) / 86_400_000) + 1;

// Returns the period itself and the period right before it, for comparison.
function getPeriod(mode) {
  const today = todayInTz();
  const weekday = today.getUTCDay() || 7; // Mon=1..Sun=7
  let from, to, prevFrom, prevTo;

  switch (mode) {
    case "today":
      from = to = today; break;
    case "yesterday":
      from = to = addDays(today, -1); break;
    case "thisweek":
      from = addDays(today, 1 - weekday); to = today; break;
    case "lastweek":
      from = addDays(today, 1 - weekday - 7); to = addDays(from, 6); break;
    case "month":
      from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)); to = today; break;
    case "lastmonth":
      from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      to   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      prevFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
      prevTo   = addDays(from, -1);
      break;
    case "week":
    default:
      from = addDays(today, -6); to = today;
  }

  if (mode === "month") {
    // Same days of the previous month, so a partial month compares fairly.
    prevFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    prevTo   = addDays(prevFrom, daysBetween(from, to) - 1);
  }
  if (!prevFrom) {
    const len = daysBetween(from, to);
    prevTo = addDays(from, -1);
    prevFrom = addDays(prevTo, 1 - len);
  }

  return {
    mode,
    label: MODES[mode] || MODES.week,
    from: iso(from), to: iso(to),
    prevFrom: iso(prevFrom), prevTo: iso(prevTo),
    days: daysBetween(from, to),
    // Forward-looking window for the schedule: the next 14 days after today.
    aheadFrom: iso(addDays(today, 1)), aheadTo: iso(addDays(today, 14)),
  };
}

module.exports = { MODES, getPeriod };
