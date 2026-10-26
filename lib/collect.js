"use strict";
// Pulls one period's numbers from MoveBoard MCP into a single JSON object for the analysis.
const { callTool } = require("./moveboard");

const custom = (from, to) => ({ period: "custom", from, to });

// Drop what the analysis doesn't need: links, branch/time boilerplate and customer-written text.
function slim(result) {
  if (!result || typeof result !== "object") return result;
  const { open_in_moveboard, branches, times, note, ...rest } = result;
  return JSON.parse(JSON.stringify(rest, (key, value) => (key === "untrusted_text" ? undefined : value)));
}

async function safe(label, fn) {
  try {
    return slim(await fn());
  } catch (e) {
    console.error(`[collect] ${label}: ${e.message}`);
    return { error: e.message };
  }
}

// ── BOL hours ────────────────────────────────────────────────────────────────
// The crew's labor time only exists in the order's change log, written two ways:
//   "saved the bill of lading; ...; Service labor time: 0 min → 3 h 45 min"
//   "changed the service labor time from 0 min to 2 h 00 min"
// The latest one wins. "Labor time: …" without "Service" is the quote, not the job.
const LABOR_RE  = /service labor time(?::| from) .*?(?:→|\bto\b) (?:(\d+) h )?(\d+) min/i;
const TRAVEL_RE = /travel time charge: \$[\d.,]+ → \$([\d.,]+)/i;

const minutes = (h, m) => (Number(h) || 0) * 60 + (Number(m) || 0);
const money = s => (s == null ? null : Number(String(s).replace(/,/g, "")));

function parseActivity(activity) {
  const items = activity?.answer?.untrusted_text || [];
  let laborMin = null, travelCharge = null, arrivedAt = null, lastBolAt = null, bolSaves = 0;

  // Newest first: the first match is the latest value.
  for (const item of items) {
    const text = item.text || "";
    if (laborMin === null) {
      const m = text.match(LABOR_RE);
      if (m) laborMin = minutes(m[1], m[2]);
    }
    if (travelCharge === null) {
      const t = text.match(TRAVEL_RE);
      if (t) travelCharge = money(t[1]);
    }
    if (/saved the bill of lading/i.test(text)) {
      bolSaves++;
      lastBolAt = lastBolAt || item.when;
    }
    if (/marked the job “Arrived”/.test(text)) arrivedAt = item.when;
  }
  return { laborMin, travelChargeFromBol: travelCharge, arrivedAt, lastBolAt, bolSaves, changeCount: activity?.answer?.counts?.changes };
}

async function collectJobs(from, to) {
  const list = await callTool("find_orders", { status: "BOOKED", move_period: "custom", move_from: from, move_to: to, limit: 50 });
  const orders = list?.answer?.orders || [];
  const jobs = [];

  for (const o of orders) {
    if (!/Completed/i.test(o.status)) continue;
    try {
      const [details, activity] = await Promise.all([
        callTool("order_details", { order: { id: o.id } }),
        callTool("order_activity", { order: { id: o.id }, limit: 20 }),
      ]);
      const d = details?.answer || {};
      const day = (d.days || [])[0] || {};
      const closing = d.closing || {};
      const bol = parseActivity(activity);

      const labor  = money(closing.labor);
      const travel = money(closing.travel);
      const hours  = bol.laborMin != null ? bol.laborMin / 60 : null;
      const crewRate = hours ? labor / hours : null;

      jobs.push({
        number:        o.number,
        moveDate:      o.move_date,
        service:       o.service,
        size:          o.size,
        leadSource:    d.leadSource,
        crewSize:      day.crew,
        trucks:        day.trucks,
        quoteMin:      money(d.quoteMin),
        quoteMax:      money(d.quoteMax),
        finalTotal:    money(closing.grandTotal),
        labor, travel,
        fuel:          money(closing.fuel),
        tips:          money(closing.tips?.total),
        laborHours:    hours,
        travelHours:   crewRate && travel ? +(travel / crewRate).toFixed(2) : null,
        crewHourlyRate: crewRate ? +crewRate.toFixed(2) : null,
        revenuePerManHour: hours && day.crew ? +(money(closing.grandTotal) / (hours * day.crew)).toFixed(2) : null,
        bolHoursFound: bol.laborMin != null,
        bolSaves:      bol.bolSaves,
      });
    } catch (e) {
      console.error(`[collect] job ${o.number}: ${e.message}`);
      jobs.push({ number: o.number, moveDate: o.move_date, error: e.message });
    }
  }

  return {
    ordersOnCalendar: list?.answer?.total ?? orders.length,
    listedHere:       orders.length,
    truncated:        (list?.answer?.total ?? 0) > orders.length,
    completedJobs:    jobs,
  };
}

// ── Everything for one report ────────────────────────────────────────────────

async function collectReport(p) {
  const cur  = custom(p.from, p.to);
  const prev = custom(p.prevFrom, p.prevTo);
  const grain = p.days > 31 ? "month" : p.days > 14 ? "week" : "day";

  const data = {
    period:   { from: p.from, to: p.to, days: p.days },
    previous: { from: p.prevFrom, to: p.prevTo },
    money: {
      revenue:          await safe("revenue_summary", () => callTool("revenue_summary", { ...cur, grain })),
      revenuePrevious:  await safe("revenue_summary prev", () => callTool("revenue_summary", { ...prev, grain })),
      paymentsByType: {
        all:         await safe("payments any", () => callTool("payments_collected", { ...cur, type: "any" })),
        cash:        await safe("payments cash", () => callTool("payments_collected", { ...cur, type: "cash" })),
        credit_card: await safe("payments card", () => callTool("payments_collected", { ...cur, type: "credit_card" })),
        check:       await safe("payments check", () => callTool("payments_collected", { ...cur, type: "check" })),
      },
      paymentsPrevious: await safe("payments prev", () => callTool("payments_collected", { ...prev, type: "any" })),
      scheduledAhead:   await safe("moves_scheduled", () => callTool("moves_scheduled", custom(p.aheadFrom, p.aheadTo))),
    },
    leads: {
      funnel:            await safe("leads_summary", () => callTool("leads_summary", cur)),
      funnelPrevious:    await safe("leads_summary prev", () => callTool("leads_summary", prev)),
      bookings:          await safe("bookings_summary", () => callTool("bookings_summary", cur)),
      bookingsPrevious:  await safe("bookings_summary prev", () => callTool("bookings_summary", prev)),
      bySource:          await safe("breakdown lead_source", () => callTool("breakdown", { ...cur, by: "lead_source" })),
      bySourcePrevious:  await safe("breakdown lead_source prev", () => callTool("breakdown", { ...prev, by: "lead_source" })),
      byService:         await safe("breakdown service", () => callTool("breakdown", { ...cur, by: "service" })),
      byMoveSize:        await safe("breakdown move_size", () => callTool("breakdown", { ...cur, by: "move_size" })),
      byMoveType:        await safe("breakdown move_type", () => callTool("breakdown", { ...cur, by: "move_type" })),
      bySalesperson:     await safe("sales_by_person", () => callTool("sales_by_person", cur)),
      pipelineNow:       await safe("pipeline_counts", () => callTool("pipeline_counts", {})),
    },
    jobsAndHours: await safe("jobs", () => collectJobs(p.from, p.to)),
  };
  return data;
}

module.exports = { collectReport, parseActivity };
