"use strict";
// The marketing side of the business: Google Search, the website and the
// ChatGPT ads. Each source renders on its own (/seo, /ga, /ads) as plain
// numbers, and /marketing hands all three to Claude at once — the questions
// worth asking cut across them. Traffic that never converts and conversions
// with no traffic behind them are both invisible in a single source.

const { collectSearchConsole } = require("./searchConsole");
const { collectAnalytics }     = require("./analytics");
const { collectAds }           = require("./ads");
const { esc, kpiCard, bullets, expandable, dateRange, RU } = require("./format");

const T = RU
  ? { search: "Поиск Google", site: "Сайт", ads: "Реклама ChatGPT", queries: "Запросы", pages: "Страницы",
      channels: "Каналы", conversions: "Конверсии", landing: "Посадочные", test: "Тест креативов",
      vs: "против", noData: "нет данных за период", lag: "Search Console отстаёт на 2–3 дня, последний день с данными",
      notMeasured: "конверсии считаются только с 26 октября — раньше их не измеряли, а не их не было" }
  : { search: "Google Search", site: "Website", ads: "ChatGPT ads", queries: "Queries", pages: "Pages",
      channels: "Channels", conversions: "Conversions", landing: "Landing pages", test: "Creative test",
      vs: "vs", noData: "no data for this period", lag: "Search Console lags 2-3 days; last day with data",
      notMeasured: "conversions have only been recorded since 26 October — earlier means unmeasured, not zero" };

const pct  = v => `${(v * 100).toFixed(2)}%`;
const usd  = v => `$${v.toFixed(2)}`;
const n0   = v => Math.round(v).toLocaleString(RU ? "ru-RU" : "en-US");
const pos  = v => v.toFixed(1);

/** Percent change as a bare string plus a direction; blank when there is nothing to compare. */
function delta(now, before) {
  if (!before) return { change: "", trend: "flat" };
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return { change: "", trend: "flat" };
  return { change: `${Math.abs(d * 100).toFixed(0)}%`, trend: d > 0 ? "up" : "down" };
}

/** The creative test's standing, in the report's language. */
function verdictText(v, needed) {
  const q = n => `«${n}»`;
  if (v.kind === "clear") {
    return RU ? `${q(v.best)} впереди всех остальных за пределами погрешности.`
              : `${q(v.best)} is ahead of every other ad beyond the noise.`;
  }
  if (v.kind === "partial") {
    const list = v.beaten.map(q).join(", ");
    return RU ? `${q(v.best)} обходит ${list}; с остальными интервалы пересекаются.`
              : `${q(v.best)} beats ${list}; the rest still overlap.`;
  }
  const short = v.short
    ? (RU ? `, и у ${v.short} объявл. меньше ${needed} показов` : `, and ${v.short} ad(s) are under ${needed} impressions`)
    : "";
  return RU ? `Победителя пока нет — интервалы пересекаются${short}. Ничего не отключай.`
            : `No winner yet — the ranges overlap${short}. Don't switch anything off.`;
}

const header = (title, period) =>
  `<b>${esc(title)} · ${esc(dateRange(period.from, period.to))}</b>\n` +
  `<i>${esc(T.vs)} ${esc(dateRange(period.prevFrom, period.prevTo))}</i>`;

// ── Search Console ───────────────────────────────────────────────────────────

function renderSearchConsole(d, period) {
  const blocks = [];
  if (d.totals.empty) {
    blocks.push(`${header("🔍 " + T.search, period)}\n\n${esc(T.noData)} (${esc(d.site)})`);
    return blocks;
  }
  const kpis = [
    { label: RU ? "Клики"   : "Clicks",      value: n0(d.totals.clicks),      ...delta(d.totals.clicks, d.previous.clicks) },
    { label: RU ? "Показы"  : "Impressions", value: n0(d.totals.impressions), ...delta(d.totals.impressions, d.previous.impressions) },
    { label: "CTR",                          value: pct(d.totals.ctr),        ...delta(d.totals.ctr, d.previous.ctr) },
    { label: RU ? "Позиция" : "Position",    value: pos(d.totals.position),   ...delta(d.previous.position, d.totals.position) },
  ];
  // The header shows the window actually measured, not the one asked for.
  blocks.push(`${header("🔍 " + T.search, d.window || period)}\n\n<pre>${esc(kpiCard(kpis))}</pre>` +
    (d.window?.clipped ? `\n<i>${esc(T.lag)}: ${esc(d.lastDayWithData)}</i>` : ""));

  if (d.queries.length) {
    blocks.push(expandable(`🔎 ${T.queries}`, d.queries.slice(0, 15).map(q =>
      `• ${esc(q.query)} — ${n0(q.clicks)} / ${n0(q.impressions)} · ${pos(q.position)}`).join("\n")));
  }
  if (d.pages.length) {
    blocks.push(expandable(`📄 ${T.pages}`, d.pages.slice(0, 15).map(p =>
      `• ${esc(p.page)} — ${n0(p.clicks)} / ${n0(p.impressions)} · ${pos(p.position)}`).join("\n")));
  }
  return blocks;
}

// ── Analytics ────────────────────────────────────────────────────────────────

function renderAnalytics(d, period) {
  const kpis = [
    { label: RU ? "Сессии"   : "Sessions",    value: n0(d.totals.sessions),  ...delta(d.totals.sessions, d.previous.sessions) },
    { label: RU ? "Люди"     : "Users",       value: n0(d.totals.users),     ...delta(d.totals.users, d.previous.users) },
    { label: RU ? "Просмотры": "Pageviews",   value: n0(d.totals.pageViews), ...delta(d.totals.pageViews, d.previous.pageViews) },
    { label: RU ? "Конверсии": "Conversions", value: n0(d.totals.keyEvents),
      ...(d.conversionsComparable ? delta(d.totals.keyEvents, d.previous.keyEvents) : { change: "", trend: "flat" }) },
  ];
  const blocks = [`${header("📈 " + T.site, period)}\n\n<pre>${esc(kpiCard(kpis))}</pre>` +
    (d.conversionsComparable ? "" : `\n<i>${esc(T.notMeasured)}</i>`)];

  if (d.events.length) {
    blocks.push(`🎯 <b>${T.conversions}</b>\n` + d.events.map(e => `• ${esc(e.key)}: ${n0(e.eventCount)}`).join("\n"));
  }
  if (d.channels.length) {
    blocks.push(expandable(`🚪 ${T.channels}`, d.channels.map(c =>
      `• ${esc(c.key)}: ${n0(c.sessions)}${c.keyEvents ? ` → ${n0(c.keyEvents)}` : ""}`).join("\n")));
  }
  if (d.landingPages.length) {
    blocks.push(expandable(`📄 ${T.landing}`, d.landingPages.slice(0, 15).map(p =>
      `• ${esc(p.key.slice(0, 48))}: ${n0(p.sessions)}${p.keyEvents ? ` → ${n0(p.keyEvents)}` : ""}`).join("\n")));
  }
  return blocks;
}

// ── ChatGPT ads ──────────────────────────────────────────────────────────────

function renderAds(d, period) {
  if (d.error) return [`${header("💸 " + T.ads, period)}\n\n${esc(d.error)}`];
  const kpis = [
    { label: RU ? "Траты"  : "Spend",       value: usd(d.totals.spend),       ...delta(d.totals.spend, d.previous.spend) },
    { label: RU ? "Показы" : "Impressions", value: n0(d.totals.impressions),  ...delta(d.totals.impressions, d.previous.impressions) },
    { label: RU ? "Клики"  : "Clicks",      value: n0(d.totals.clicks),       ...delta(d.totals.clicks, d.previous.clicks) },
    { label: "CTR",                         value: pct(d.totals.ctr),         ...delta(d.totals.ctr, d.previous.ctr) },
    { label: "CPC",                         value: d.totals.cpc ? usd(d.totals.cpc) : "—", ...delta(d.previous.cpc, d.totals.cpc) },
  ];
  const blocks = [`${header("💸 " + T.ads, period)}\n\n<pre>${esc(kpiCard(kpis))}</pre>`];

  const conv = Object.entries(d.conversions);
  if (conv.length) {
    blocks.push(`🎯 <b>${T.conversions}</b>\n` + conv.map(([k, v]) => `• ${esc(k)}: ${n0(v)}`).join("\n"));
  }
  const test = d.creativeTest;
  if (test.ads.length) {
    const lines = test.ads.map(a =>
      `• ${esc(a.name)}: ${n0(a.impressions)} / ${n0(a.clicks)} · ${pct(a.ctr)} (${pct(a.range[0])}–${pct(a.range[1])})`);
    if (test.verdict) lines.push("", `→ ${esc(verdictText(test.verdict, test.impressionsNeeded))}`);
    blocks.push(expandable(`🧪 ${T.test} ${RU ? "с" : "since"} ${test.since}`, lines.join("\n")));
  }
  return blocks;
}

// ── All three ────────────────────────────────────────────────────────────────

/** Each source independently, so one failure cannot take the report down. */
async function collectMarketing(period) {
  const [searchConsole, analytics, ads] = await Promise.all([
    collectSearchConsole(period).catch(e => ({ error: e.message })),
    collectAnalytics(period).catch(e => ({ error: e.message })),
    collectAds(period).catch(e => ({ error: e.message })),
  ]);
  return { searchConsole, analytics, ads };
}

const SOURCE = { searchConsole: T.search, analytics: T.site, ads: T.ads };

// Renders Claude's verdict over the three sources. The raw data comes along so
// a source that never answered can be named.
function renderMarketing(r, period, data = {}) {
  const blocks = [
    `<b>📊 ${esc(RU ? "Маркетинг" : "Marketing")} · ${esc(dateRange(period.from, period.to))}</b>\n` +
    `<i>${esc(T.vs)} ${esc(dateRange(period.prevFrom, period.prevTo))}</i>\n\n` +
    `${esc(r.headline)}\n\n<pre>${esc(kpiCard(r.kpis))}</pre>`,
  ];
  if (r.working?.length)  blocks.push(`✅ <b>${RU ? "Работает" : "Working"}</b>\n${bullets(r.working)}`);
  if (r.problems?.length) blocks.push(`⚠️ <b>${RU ? "Проблемы" : "Problems"}</b>\n${bullets(r.problems)}`);
  if (r.actions?.length) {
    blocks.push(`🎯 <b>${RU ? "Сделать" : "Do this week"}</b>\n` + r.actions.map((a, i) =>
      `${i + 1}. <b>${esc(a.title)}</b>${a.detail ? ` — ${esc(a.detail)}` : ""}`).join("\n"));
  }
  if (r.search?.length) blocks.push(expandable(`🔍 ${T.search}`, bullets(r.search)));
  if (r.site?.length)   blocks.push(expandable(`📈 ${T.site}`, bullets(r.site)));
  if (r.ads?.length)    blocks.push(expandable(`💸 ${T.ads}`, bullets(r.ads)));
  if (r.tooEarly?.length) {
    blocks.push(expandable(`🤔 ${RU ? "Слишком рано судить" : "Too early to call"}`, bullets(r.tooEarly)));
  }

  // A source that failed is a hole in the report, not a quiet zero. Claude is
  // handed the error too, but whether it mentions it is a judgement call; that
  // a third of the picture is missing is a fact, and it goes in plainly.
  const failed = Object.entries(data).filter(([, d]) => d?.error);
  if (failed.length) {
    blocks.push(`⚠️ <b>${RU ? "Источник недоступен" : "Source unavailable"}</b>\n` +
      failed.map(([k, d]) => `• ${esc(SOURCE[k] || k)}: ${esc(d.error)}`).join("\n"));
  }
  return blocks;
}

module.exports = {
  collectSearchConsole, collectAnalytics, collectAds, collectMarketing,
  renderSearchConsole, renderAnalytics, renderAds, renderMarketing,
};
