"use strict";
// Search Console for a period, with the same period before it to compare.
//
// Two properties exist. The domain one covers www and non-www together and is
// the right answer, but it was only created on 2026-10-26 and Search Console
// backfills slowly, so it can still be empty. The old URL-prefix property
// holds the history. Whichever has data for the period wins, and the report
// says which one it used, because their numbers are not interchangeable.
//
// Search Console is also two to three days behind: the last days of a period
// that ends today will read as zero. collect() reports the real last day with
// data so nothing gets mistaken for a collapse in traffic.

const { googleApi } = require("./google");

const SCOPE  = "https://www.googleapis.com/auth/webmasters.readonly";
const DOMAIN = "sc-domain:mountsimovers.com";
const PREFIX = "https://mountsimovers.com/";

const query = (site, body) =>
  googleApi(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    SCOPE,
    body
  );

const totalsOf = rows => {
  const r = rows?.[0];
  if (!r) return { clicks: 0, impressions: 0, ctr: 0, position: 0, empty: true };
  return { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, empty: false };
};

async function pickSite(from, to) {
  const failures = [];
  for (const site of [DOMAIN, PREFIX]) {
    try {
      const r = await query(site, { startDate: from, endDate: to, dimensions: [] });
      if (r.rows?.length) return { site, totals: totalsOf(r.rows) };
    } catch (e) {
      // No access to that property, or it does not exist — try the other.
      failures.push(e);
    }
  }
  // Both refused: the credential is broken, or neither property is readable.
  // Reporting "no data" there would be a statement about the traffic, which
  // is a different thing and the kind of lie that goes unnoticed for weeks.
  if (failures.length === 2) throw failures[0];
  return { site: PREFIX, totals: totalsOf(null) };
}

const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

async function collectSearchConsole(period) {
  const { site } = await pickSite(period.from, period.to);

  // Where the data actually stops. Comparing a part-reported week against a
  // whole one would read as a collapse every single Monday, so the window is
  // cut back to the last day with data and the previous window is cut to the
  // same length.
  const daily = await query(site, { startDate: period.from, endDate: period.to, dimensions: ["date"], rowLimit: 100 }).catch(() => ({}));
  const withData = (daily.rows || []).filter(r => r.impressions > 0).map(r => r.keys[0]).sort();
  const lastDay = withData[withData.length - 1] || null;

  const to = lastDay && lastDay < period.to ? lastDay : period.to;
  const length = daysBetween(period.from, to);
  const prevTo = addDays(period.from, -1);
  const prevFrom = addDays(prevTo, 1 - length);
  const window = { from: period.from, to, prevFrom, prevTo, clipped: to !== period.to };

  const [totals, prev, queries, pages] = await Promise.all([
    query(site, { startDate: window.from, endDate: window.to, dimensions: [] }).then(r => totalsOf(r.rows)).catch(() => totalsOf(null)),
    query(site, { startDate: window.prevFrom, endDate: window.prevTo, dimensions: [] }).then(r => totalsOf(r.rows)).catch(() => totalsOf(null)),
    query(site, { startDate: window.from, endDate: window.to, dimensions: ["query"], rowLimit: 25 }).catch(() => ({})),
    query(site, { startDate: window.from, endDate: window.to, dimensions: ["page"], rowLimit: 25 }).catch(() => ({})),
  ]);

  return {
    site,
    counted: "Google Search: clicks and impressions for the site's own pages. Position is the average rank across impressions. Search Console lags 2-3 days, so the window ends at the last day that has data and the comparison window is the same number of days.",
    lastDayWithData: lastDay,
    window,
    totals,
    previous: prev,
    queries: (queries.rows || []).map(r => ({
      query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
    })),
    pages: (pages.rows || []).map(r => ({
      page: r.keys[0].replace(/^https?:\/\/(www\.)?mountsimovers\.com/, "") || "/",
      clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
    })),
  };
}

module.exports = { collectSearchConsole };
