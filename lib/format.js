"use strict";
// Renders the structured report as Telegram HTML: a KPI card up top, the short verdict,
// and the detail sections folded into expandable quotes.

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LOCALE = (process.env.REPORT_LANGUAGE || "English").toLowerCase().startsWith("rus") ? "ru-RU" : "en-US";
const RU = LOCALE === "ru-RU";

const T = RU
  ? { vs: "против", working: "Работает", problems: "Проблемы", actions: "Сделать", sources: "Источники лидов",
      jobs: "Работы и часы", ahead: "Впереди 14 дней", leads: "лид.", booked: "брон." }
  : { vs: "vs", working: "Working", problems: "Problems", actions: "Do this week", sources: "Lead sources",
      jobs: "Jobs & hours", ahead: "Next 14 days", leads: "leads", booked: "booked" };

function dateRange(from, to) {
  const f = new Date(from + "T12:00:00Z"), t = new Date(to + "T12:00:00Z");
  const day = d => d.toLocaleDateString(LOCALE, { day: "numeric", timeZone: "UTC" });
  const dm  = d => d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
  if (from === to) return dm(f);
  if (f.getUTCMonth() === t.getUTCMonth()) return RU ? `${day(f)}–${dm(t)}` : `${dm(f)}–${day(t)}`;
  return `${dm(f)} – ${dm(t)}`;
}

const ARROW = { up: "▲", down: "▼", flat: "•" };

function kpiCard(kpis) {
  const rows = kpis.slice(0, 7);
  const lw = Math.max(...rows.map(k => k.label.length));
  const vw = Math.max(...rows.map(k => k.value.length));
  return rows.map(k => {
    const change = k.change ? `${ARROW[k.trend] || ""}${k.change}` : "";
    return `${k.label.padEnd(lw)}  ${k.value.padStart(vw)}  ${change}`.trimEnd();
  }).join("\n");
}

const bullets = items => items.map(s => `• ${esc(s)}`).join("\n");

function expandable(title, body) {
  return `<blockquote expandable><b>${esc(title)}</b>\n${body}</blockquote>`;
}

// Returns a list of HTML blocks; each block must stay whole inside one Telegram message.
function renderReport(r, period) {
  const blocks = [];

  blocks.push(
    `<b>📊 Mount Si Movers · ${esc(dateRange(period.from, period.to))}</b>\n` +
    `<i>${esc(T.vs)} ${esc(dateRange(period.prevFrom, period.prevTo))}</i>\n\n` +
    `${esc(r.headline)}\n\n` +
    `<pre>${esc(kpiCard(r.kpis))}</pre>`
  );

  if (r.working?.length)  blocks.push(`✅ <b>${T.working}</b>\n${bullets(r.working)}`);
  if (r.problems?.length) blocks.push(`⚠️ <b>${T.problems}</b>\n${bullets(r.problems)}`);
  if (r.actions?.length) {
    blocks.push(`🎯 <b>${T.actions}</b>\n` + r.actions.map((a, i) =>
      `${i + 1}. <b>${esc(a.title)}</b>${a.detail ? ` — ${esc(a.detail)}` : ""}`).join("\n"));
  }

  if (r.sources?.length) {
    blocks.push(expandable(`📈 ${T.sources}`, r.sources.map(s =>
      `• <b>${esc(s.name)}</b>: ${esc(s.leads)} ${T.leads} → ${esc(s.booked)} ${T.booked}` +
      (s.value ? ` · ${esc(s.value)}` : "") + (s.note ? ` — ${esc(s.note)}` : "")).join("\n")));
  }
  if (r.jobs) {
    const lines = [esc(r.jobs.summary)];
    for (const j of r.jobs.flagged || []) lines.push(`• <b>${esc(j.order)}</b> ${esc(j.note)}`);
    blocks.push(expandable(`⏱ ${T.jobs}`, lines.join("\n")));
  }
  if (r.ahead?.length) blocks.push(expandable(`🗓 ${T.ahead}`, bullets(r.ahead)));

  return blocks;
}

// Packs blocks into as few messages as fit Telegram's 4096-character limit.
function packMessages(blocks, limit = 3900) {
  const messages = [];
  let current = "";
  for (const block of blocks) {
    if (current && (current + "\n\n" + block).length > limit) {
      messages.push(current);
      current = block;
    } else {
      current += (current ? "\n\n" : "") + block;
    }
  }
  if (current) messages.push(current);
  return messages;
}

module.exports = { renderReport, packMessages };
