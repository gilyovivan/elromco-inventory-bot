"use strict";
// GA4 for a period, with the same period before it to compare.
//
// Two things to know when reading these numbers.
//
// Conversions only started being recorded on 2026-10-26. Before that the site
// pushed call_click, quote_lead and the chat events into the dataLayer and no
// tag in GTM forwarded them, so any earlier period shows zero — which means
// "not measured", not "nobody called".
//
// Pageviews before that same date are doubled: two tags each sent page_view.
// Sessions and users were never affected.

const { googleApi } = require("./google");

const SCOPE    = "https://www.googleapis.com/auth/analytics.readonly";
const PROPERTY = process.env.GA4_PROPERTY_ID || "469995063";
const MEASUREMENT_FIXED_ON = "2026-10-26";

// Existing customers reach the Elromco portal through a link in an email that
// lands on our homepage and bounces onward. GTM stopped recording them on
// 2026-10-26; older periods still carry them, so they are filtered out here
// too and the two halves of a comparison stay comparable.
const PORTAL = "authToken|redirectUrl|companyId";

const run = body => googleApi(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, SCOPE, body);

const notPortal = {
  notExpression: {
    filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "FULL_REGEXP", value: `.*(${PORTAL}).*` } },
  },
};

const num = v => Number(v ?? 0);

function rowsOf(res, metrics) {
  return (res.rows || []).map(r => {
    const out = { key: r.dimensionValues.map(d => d.value).join(" / ") };
    metrics.forEach((m, i) => { out[m] = num(r.metricValues[i]?.value); });
    return out;
  });
}

async function totalsFor(from, to) {
  const res = await run({
    dateRanges: [{ startDate: from, endDate: to }],
    dimensionFilter: notPortal,
    metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }, { name: "engagedSessions" }, { name: "keyEvents" }],
  });
  const v = res.rows?.[0]?.metricValues || [];
  return {
    sessions: num(v[0]?.value), users: num(v[1]?.value), pageViews: num(v[2]?.value),
    engagedSessions: num(v[3]?.value), keyEvents: num(v[4]?.value),
  };
}

async function collectAnalytics(period) {
  const [totals, previous, channels, events, landing] = await Promise.all([
    totalsFor(period.from, period.to),
    totalsFor(period.prevFrom, period.prevTo),
    run({
      dateRanges: [{ startDate: period.from, endDate: period.to }],
      dimensionFilter: notPortal,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 12,
    }).then(r => rowsOf(r, ["sessions", "keyEvents"])).catch(() => []),
    run({
      dateRanges: [{ startDate: period.from, endDate: period.to }],
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: {
        filter: { fieldName: "eventName", inListFilter: { values: ["quote_lead", "call_click", "text_click", "chat_message_sent", "quote_open", "chat_open"] } },
      },
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 20,
    }).then(r => rowsOf(r, ["eventCount"])).catch(() => []),
    run({
      dateRanges: [{ startDate: period.from, endDate: period.to }],
      dimensionFilter: notPortal,
      // Without the query string: ad click ids and portal tokens would
      // otherwise fill the list with one-session rows of the same page.
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 20,
    }).then(r => rowsOf(r, ["sessions", "keyEvents"])).catch(() => []),
  ]);

  return {
    counted: "GA4 sessions, excluding the Elromco portal links existing customers arrive on. Conversions (calls, texts, quote submissions, first chat message) have only been recorded since " + MEASUREMENT_FIXED_ON + "; earlier periods read zero because nothing forwarded them, not because nobody converted.",
    conversionsMeasuredSince: MEASUREMENT_FIXED_ON,
    conversionsComparable: period.prevFrom >= MEASUREMENT_FIXED_ON,
    pageViewsDoubledBefore: MEASUREMENT_FIXED_ON,
    totals,
    previous,
    channels,
    events,
    landingPages: landing,
  };
}

module.exports = { collectAnalytics };
