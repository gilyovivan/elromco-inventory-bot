"use strict";
const express  = require("express");
const schedule = require("node-schedule");

const { MODES, getPeriod }              = require("./lib/periods");
const { collectReport }                 = require("./lib/collect");
const { analyzeReport, analyzeMarketing, answerQuestion } = require("./lib/claude");
const { renderReport, packMessages }    = require("./lib/format");
const {
  collectSearchConsole, collectAnalytics, collectAds, collectMarketing,
  renderSearchConsole, renderAnalytics, renderAds, renderMarketing,
} = require("./lib/marketing");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Config ────────────────────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PORT       = process.env.PORT || 3000;

// The mountsimovers.com site posts its Business Profile drafts through this
// bot, because a Telegram bot has exactly one receiver and this one polls.
// Anything we don't recognise is relayed to the site's webhook, which owns
// that flow. Without SITE_WEBHOOK_SECRET the relay is simply off.
const SITE_WEBHOOK_URL    = process.env.SITE_WEBHOOK_URL || "https://www.mountsimovers.com/api/telegram-webhook";
const SITE_WEBHOOK_SECRET = process.env.SITE_WEBHOOK_SECRET || "";

const ALLOWED_MODES = Object.keys(MODES);
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  return res.json();
}

async function sendTelegram(text) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > 3800 && current) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current.trim());

  for (const chunk of chunks) {
    const sent = await tg("sendMessage", { chat_id: TG_CHAT_ID, text: chunk, parse_mode: "Markdown" });
    // Unbalanced * or _ make Telegram reject the whole message: resend it as plain text.
    if (!sent.ok) await tg("sendMessage", { chat_id: TG_CHAT_ID, text: chunk });
    await delay(400);
  }
}

// Report messages are already packed and HTML-formatted.
async function sendTelegramHtml(messages) {
  for (const html of messages) {
    const sent = await tg("sendMessage", { chat_id: TG_CHAT_ID, text: html, parse_mode: "HTML" });
    if (!sent.ok) {
      console.error("Telegram HTML rejected:", sent.description);
      await tg("sendMessage", { chat_id: TG_CHAT_ID, text: html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") });
    }
    await delay(400);
  }
}

// The standing menu under the text field. A reply keyboard rather than
// inline buttons: inline ones belong to the message they came with and
// scroll away with it, while this stays put and is what the owner reaches
// for on a phone. Button labels follow REPORT_LANGUAGE, and MENU maps each
// label back to what it runs.
const RU = (process.env.REPORT_LANGUAGE || "English").toLowerCase().startsWith("rus");

const MENU = RU
  ? {
      "📊 Заказы":    { kind: "periods", of: "orders" },
      "📈 Маркетинг": { kind: "periods", of: "marketing" },
      "🔍 Поиск":     { kind: "source",  cmd: "seo" },
      "🌐 Сайт":      { kind: "source",  cmd: "ga" },
      "💸 Реклама":   { kind: "source",  cmd: "ads" },
      "📣 В Google":  { kind: "relay",   cmd: "gbp" },
    }
  : {
      "📊 Orders":    { kind: "periods", of: "orders" },
      "📈 Marketing": { kind: "periods", of: "marketing" },
      "🔍 Search":    { kind: "source",  cmd: "seo" },
      "🌐 Website":   { kind: "source",  cmd: "ga" },
      "💸 Ads":       { kind: "source",  cmd: "ads" },
      "📣 To Google": { kind: "relay",   cmd: "gbp" },
    };

function mainMenu() {
  const labels = Object.keys(MENU);
  const rows = [];
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2).map(text => ({ text })));
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

/** Period buttons. "orders" keeps its bare mode names, which the polling loop
 *  already understands; "marketing" prefixes them so the two cannot collide. */
function periodKeyboard(of) {
  const p = of === "marketing" ? "mk:" : "";
  return {
    inline_keyboard: [
      [{ text: MODES.today,     callback_data: p + "today"     }, { text: MODES.yesterday, callback_data: p + "yesterday" }],
      [{ text: MODES.thisweek,  callback_data: p + "thisweek"  }, { text: MODES.lastweek,  callback_data: p + "lastweek"  }],
      [{ text: MODES.week,      callback_data: p + "week"      }, { text: MODES.month,     callback_data: p + "month"     }],
      [{ text: MODES.lastmonth, callback_data: p + "lastmonth" }],
    ],
  };
}

const ASK_PERIOD = RU
  ? { orders: "*Заказы* — за какой период?", marketing: "*Маркетинг* — за какой период?" }
  : { orders: "*Orders* — which period?",    marketing: "*Marketing* — which period?" };

async function sendMenu(text) {
  await tg("sendMessage", { chat_id: TG_CHAT_ID, text, parse_mode: "Markdown", reply_markup: mainMenu() });
}

async function sendPeriods(text, of) {
  await tg("sendMessage", { chat_id: TG_CHAT_ID, text, parse_mode: "Markdown", reply_markup: periodKeyboard(of) });
}

// Hands an update to the website, which answers in this chat as this bot.
// Best-effort: a relay failure must never stop the polling loop.
async function relayToSite(update) {
  if (!SITE_WEBHOOK_SECRET) return false;
  try {
    const res = await fetch(SITE_WEBHOOK_URL, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": SITE_WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
    });
    if (!res.ok) console.error("Relay rejected:", res.status);
    return res.ok;
  } catch (e) {
    console.error("Relay failed:", e.message);
    return false;
  }
}

async function setMyCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "report",    description: "📊 Choose report period" },
      { command: "lastweek",  description: "⬅️ Last week" },
      { command: "week",      description: "📅 Last 7 days" },
      { command: "month",     description: "📆 This month" },
      { command: "lastmonth", description: "⬅️ Last month" },
      { command: "today",     description: "📅 Today" },
      { command: "marketing", description: "📊 Search + site + ads, with the verdict" },
      { command: "seo",       description: "🔍 Google Search only" },
      { command: "ga",        description: "📈 Website traffic only" },
      { command: "ads",       description: "💸 ChatGPT ads only" },
      { command: "gbp",       description: "📣 Offer the latest post to Google" },
      { command: "gbpnext",   description: "🗂 Next post from the archive queue" },
    ],
  });
}

// ── Main report ───────────────────────────────────────────────────────────────

async function runReport(mode = "lastweek") {
  const period = getPeriod(mode);
  console.log(`REPORT: ${mode} | ${period.from} -> ${period.to}`);

  try {
    const data = await collectReport(period);
    console.log("Data collected, analyzing...");

    const report = await analyzeReport(data, period);
    await sendTelegramHtml(packMessages(renderReport(report, period)));

    console.log("Report sent!");
    return { success: true, mode, period };
  } catch (err) {
    console.error("ERROR:", err.message);
    await sendTelegram(`Report error (${mode}): ${err.message}`).catch(() => {});
    throw err;
  }
}

// The three sources on their own: plain numbers, no Claude, a few seconds.
// MARKETING_REPORTS maps a command to how it is collected and rendered.
const MARKETING_REPORTS = {
  seo: { collect: collectSearchConsole, render: renderSearchConsole, label: "🔍 Google Search" },
  ga:  { collect: collectAnalytics,     render: renderAnalytics,     label: "📈 Website" },
  ads: { collect: collectAds,           render: renderAds,           label: "💸 ChatGPT ads" },
};

async function runMarketingSource(cmd, mode = "week") {
  const { collect, render, label } = MARKETING_REPORTS[cmd];
  const period = getPeriod(mode);
  console.log(`${cmd.toUpperCase()}: ${mode} | ${period.from} -> ${period.to}`);
  try {
    await sendTelegramHtml(packMessages(render(await collect(period), period)));
  } catch (err) {
    console.error(`${cmd} error:`, err.message);
    await sendTelegram(`${label} failed: ${err.message}`).catch(() => {});
  }
}

// All three at once, with Claude's verdict over them.
async function runMarketingReport(mode = "week") {
  const period = getPeriod(mode);
  console.log(`MARKETING: ${mode} | ${period.from} -> ${period.to}`);
  try {
    const data = await collectMarketing(period);
    const report = await analyzeMarketing(data, period);
    await sendTelegramHtml(packMessages(renderMarketing(report, period, data)));
  } catch (err) {
    console.error("MARKETING error:", err.message);
    await sendTelegram(`Marketing report failed: ${err.message}`).catch(() => {});
  }
}

async function handleQuestion(question, reportContext) {
  try {
    await sendTelegram("Thinking...");
    await sendTelegram(await answerQuestion(question, reportContext));
  } catch (err) {
    console.error("Q&A error:", err.message);
    await sendTelegram(`Error: ${err.message}`);
  }
}

// ── Telegram polling ──────────────────────────────────────────────────────────

function startReport(mode) {
  sendTelegram(`Running ${MODES[mode]} report... ~1-2 min.`).catch(() => {});
  runReport(mode).catch(e => console.error("Report error:", e.message));
}

async function startTelegramPolling() {
  let offset = 0;
  console.log("Telegram polling started");

  while (true) {
    try {
      const res  = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      if (!data.ok) { await delay(5000); continue; }

      for (const update of data.result) {
        offset = update.update_id + 1;

        // Only the owner's chat may run reports or ask questions.
        const chatId = String(update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? "");
        if (chatId !== String(TG_CHAT_ID)) continue;

        if (update.callback_query) {
          const mode = update.callback_query.data;
          if (ALLOWED_MODES.includes(mode)) {
            await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
            startReport(mode);
            continue;
          }
          if (mode?.startsWith("mk:") && ALLOWED_MODES.includes(mode.slice(3))) {
            await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
            await sendTelegram(`Collecting ${MODES[mode.slice(3)]}: search, site and ads... ~1-2 min.`).catch(() => {});
            runMarketingReport(mode.slice(3)).catch(e => console.error("marketing:", e.message));
            continue;
          }
          // Not a report period, so it belongs to the website — the Publish
          // and Skip buttons under a Business Profile draft. The site closes
          // the spinner itself; we only do it if the relay never got there,
          // otherwise the button spins forever with no explanation.
          if (!(await relayToSite(update))) {
            await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id, text: "Couldn't reach the site — try again." });
          }
          continue;
        }

        // A photo is a picture for a Business Profile draft, never a question.
        // Checked before the Q&A branch below, which would otherwise see a
        // reply with no text and ask Claude an empty question.
        if (update.message?.photo) {
          await relayToSite(update);
          continue;
        }

        const msgText = update.message?.text || "";

        // A tap on the standing menu arrives as plain text. Checked before the
        // Q&A branch so a label is never mistaken for a question.
        const label = msgText.trim();
        const menu = Object.hasOwn(MENU, label) ? MENU[label] : null;
        if (menu) {
          if (menu.kind === "periods") {
            await sendPeriods(ASK_PERIOD[menu.of], menu.of);
          } else if (menu.kind === "source") {
            runMarketingSource(menu.cmd).catch(e => console.error(`${menu.cmd}:`, e.message));
          } else {
            await relayToSite({ message: { ...update.message, text: "/" + menu.cmd } });
          }
          continue;
        }

        const replyTo = update.message?.reply_to_message;

        if (replyTo && !msgText.startsWith("/")) {
          const context = replyTo.text || replyTo.caption || "";
          if (context.length > 50) {
            handleQuestion(msgText, context).catch(e => console.error("Q&A:", e.message));
            continue;
          }
        }

        if (!msgText.startsWith("/")) continue;

        const cmd = msgText.split(" ")[0].slice(1).split("@")[0].toLowerCase();

        if (Object.hasOwn(MARKETING_REPORTS, cmd)) {
          runMarketingSource(cmd).catch(e => console.error(`${cmd}:`, e.message));
          continue;
        }

        if (cmd === "marketing") {
          await sendTelegram("Collecting Search Console, Analytics and ads... ~1-2 min.").catch(() => {});
          runMarketingReport().catch(e => console.error("marketing:", e.message));
          continue;
        }

        // Business Profile commands live on the website.
        if (cmd === "gbp" || cmd === "gbpnext") {
          await relayToSite(update);
          continue;
        }

        if (cmd === "start") {
          await sendMenu("*Mount Si Movers Analytics*");
        } else if (cmd === "report") {
          await sendPeriods(ASK_PERIOD.orders, "orders");
        } else if (ALLOWED_MODES.includes(cmd)) {
          startReport(cmd);
        } else {
          await sendMenu("*Mount Si Movers Analytics*");
        }
      }
    } catch (e) {
      console.error("Polling error:", e.message);
      await delay(5000);
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function startScheduler() {
  const tz = "America/Los_Angeles";
  schedule.scheduleJob({ rule: "0 8 * * 1", tz }, () => runReport("lastweek").catch(e => console.error(e.message)));
  schedule.scheduleJob({ rule: "0 8 1 * *", tz }, () => runReport("lastmonth").catch(e => console.error(e.message)));
  // Half an hour after the orders report, so the two don't arrive on top of
  // each other and the owner reads the money first.
  schedule.scheduleJob({ rule: "30 8 * * 1", tz }, () => runMarketingReport("lastweek").catch(e => console.error(e.message)));
  console.log("Scheduler: Mon 8am PT orders, Mon 8:30am PT marketing, 1st of month 8am PT (last month)");
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({
  status:  "ok",
  service: "Elromco Analytics Bot v3 (MoveBoard MCP)",
  modes:   ALLOWED_MODES,
}));

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`\nElromco Analytics Bot v3 on port ${PORT}`);
    startScheduler();
    setMyCommands().catch(e => console.error("setMyCommands:", e.message));
    startTelegramPolling().catch(e => console.error("Polling crashed:", e.message));
  });
}

module.exports = { runReport };
