"use strict";
// ChatGPT ads for a period, with the same period before it to compare.
// Read-only: it only GETs stats and never changes the ad account.
//
// The creative test is scored with a Wilson interval rather than raw CTR.
// With a few thousand impressions an ad can lead on CTR purely by chance, and
// turning the "loser" off then throws away the better ad. Two ads have a real
// difference only when their intervals stop overlapping.

const API = "https://api.ads.openai.com/v1";

/** The creative test running now; update when a new one starts. */
const CREATIVE_TEST_START = "2026-10-22";
/** Impressions each ad needs before a 2x CTR difference shows (see the journal). */
const IMPRESSIONS_NEEDED = 7000;

function wilson(clicks, impressions) {
  if (!impressions) return [0, 0];
  const z = 1.96, p = clicks / impressions, n = impressions;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - half), centre + half];
}

async function collectAds(period) {
  const apiKey = process.env.OPENAI_ADS_API_KEY;
  if (!apiKey) return { error: "OPENAI_ADS_API_KEY is not set" };

  const headers = { Authorization: `Bearer ${apiKey}` };
  const get = async (path, query) => {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query)) for (const item of [].concat(v)) url.searchParams.append(k, item);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Ads API ${path} responded ${res.status}`);
    return res.json();
  };
  const range = (since, until) => JSON.stringify({ type: "date_range", since, until });
  const byAd = async (since, until) => {
    const page = await get("/ad_account/insights", {
      aggregation_level: "ad",
      time_granularity:  "none",
      "time_ranges[]":   range(since, until),
      "fields[]":        ["ad.impressions", "ad.clicks", "ad.spend"],
      limit: "2000",
    });
    return (page.data || []).map(r => ({ ...r, id: r.ad_id ?? /entity_id=([^:]+)/.exec(r.id)?.[1] ?? r.id }));
  };

  const [ads, campaigns, now, before, test] = await Promise.all([
    get("/ads", { limit: "500" }),
    get("/campaigns", { limit: "500" }),
    byAd(period.from, period.to),
    byAd(period.prevFrom, period.prevTo).catch(() => []),
    CREATIVE_TEST_START <= period.to ? byAd(CREATIVE_TEST_START, period.to) : Promise.resolve([]),
  ]);
  const names = new Map((ads.data || []).map(a => [a.id, a.creative?.title ?? a.name]));

  const conversions = await fetch(`${API}/conversions/insights`, {
    method:  "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body:    JSON.stringify({
      aggregation_level: "campaign",
      entity_ids:        (campaigns.data || []).map(c => c.id),
      time_ranges:       [range(period.from, period.to)],
      time_granularity:  "none",
      include:           ["attributed_events"],
    }),
  }).then(r => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] }));

  const events = {};
  for (const row of conversions.data || []) {
    for (const e of row.attributed_events || []) {
      events[e.event_name] = (events[e.event_name] || 0) + (e.attributed_event_count || 0);
    }
  }

  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const totalsOf = rows => {
    const impressions = sum(rows, "impressions"), clicks = sum(rows, "clicks"), spend = sum(rows, "spend");
    return { impressions, clicks, spend, ctr: impressions ? clicks / impressions : 0, cpc: clicks ? spend / clicks : 0 };
  };

  const scored = test.map(r => {
    const i = Number(r.impressions ?? 0), c = Number(r.clicks ?? 0);
    return { name: names.get(r.id) ?? r.id, impressions: i, clicks: c, ctr: i ? c / i : 0, range: wilson(c, i) };
  }).sort((a, b) => b.ctr - a.ctr);

  // Structured rather than a sentence, so the renderer can word it in the
  // report's language and Claude can read it without parsing prose.
  let verdict = null;
  if (scored.length > 1) {
    const [best, ...others] = scored;
    const beaten = others.filter(o => o.range[1] < best.range[0]);
    const short = scored.filter(s => s.impressions < IMPRESSIONS_NEEDED).length;
    verdict = {
      kind: beaten.length === others.length ? "clear" : beaten.length ? "partial" : "none",
      best: best.name,
      beaten: beaten.map(b => b.name),
      short,
    };
  }

  return {
    counted: "ChatGPT ads. Conversions are attributed by the OpenAI pixel and only counted from 2026-10-21. CTR ranges are 95% Wilson intervals: two ads differ for real only when their ranges stop overlapping.",
    totals:   totalsOf(now),
    previous: totalsOf(before),
    conversions: events,
    creativeTest: { since: CREATIVE_TEST_START, impressionsNeeded: IMPRESSIONS_NEEDED, ads: scored, verdict },
  };
}

module.exports = { collectAds, CREATIVE_TEST_START };
