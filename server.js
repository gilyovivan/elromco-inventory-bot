"use strict";
const express  = require("express");
const schedule = require("node-schedule");

const { MODES, getPeriod }              = require("./lib/periods");
const { collectReport }                 = require("./lib/collect");
const { analyzeReport, answerQuestion } = require("./lib/claude");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Config ────────────────────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PORT       = process.env.PORT || 3000;

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

async function sendTelegramKeyboard(text) {
  await tg("sendMessage", {
    chat_id:      TG_CHAT_ID,
    text,
    parse_mode:   "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📅 Today",       callback_data: "today"     },
          { text: "📅 Yesterday",   callback_data: "yesterday" },
        ],
        [
          { text: "📅 This Week",   callback_data: "thisweek"  },
          { text: "⬅️ Last Week",   callback_data: "lastweek"  },
        ],
        [
          { text: "📅 Last 7 Days", callback_data: "week"      },
          { text: "📆 This Month",  callback_data: "month"     },
        ],
        [
          { text: "⬅️ Last Month",  callback_data: "lastmonth" },
        ],
      ],
    },
  });
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

    const analysis = await analyzeReport(data, period);
    const header = `*Mount Si Movers — Business Report*\n${period.label}: ${period.from} → ${period.to}\n\n`;
    await sendTelegram(header + analysis);

    console.log("Report sent!");
    return { success: true, mode, period };
  } catch (err) {
    console.error("ERROR:", err.message);
    await sendTelegram(`Report error (${mode}): ${err.message}`).catch(() => {});
    throw err;
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
          await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
          if (ALLOWED_MODES.includes(mode)) startReport(mode);
          continue;
        }

        const msgText = update.message?.text || "";
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

        if (cmd === "start" || cmd === "report") {
          await sendTelegramKeyboard("*Mount Si Movers Analytics*\n\nChoose a report period:");
        } else if (ALLOWED_MODES.includes(cmd)) {
          startReport(cmd);
        } else {
          await sendTelegramKeyboard("Choose a report period:");
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
  console.log("Scheduler: Mon 8am PT (last week) + 1st of month 8am PT (last month)");
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
