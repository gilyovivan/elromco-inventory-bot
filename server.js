"use strict";
const express      = require("express");
const { chromium } = require("playwright");
const fetch        = require("node-fetch");
const FormData     = require("form-data");
const fs           = require("fs");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Config ────────────────────────────────────────────────────────────────────
const ELROMCO_URL    = "https://app.elromco.com";
const ELROMCO_LOGIN  = process.env.ELROMCO_LOGIN  || "";
const ELROMCO_PASS   = process.env.ELROMCO_PASS   || "";
const ELROMCO_COMPID = process.env.ELROMCO_COMPID || "153";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || "";
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID || "";
const PORT           = process.env.PORT || 3000;

const ALLOWED_MODES = ["today", "yesterday", "thisweek", "lastweek", "week", "month", "lastmonth"];

const MODE_LABELS = {
  today:     "📅 Today",
  yesterday: "📅 Yesterday",
  thisweek:  "📅 This Week",
  lastweek:  "⬅️ Last Week",
  week:      "📅 Last 7 Days",
  month:     "📆 This Month",
  lastmonth: "⬅️ Last Month",
};

const PRESET_LABELS = {
  today:     "Today",
  yesterday: "Yesterday",
  thisweek:  "This Week",
  lastweek:  "Last Week",
  week:      "Last 7 Days",
  month:     "This Month",
  lastmonth: "Last Month",
};

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ──────────────────────────────────────────────────────────────

function getDateRange(mode = "week") {
  const now = new Date();
  let from, to;

  switch (mode) {
    case "today":
      from = to = new Date(now);
      break;
    case "yesterday":
      from = new Date(now);
      from.setDate(now.getDate() - 1);
      to = new Date(from);
      break;
    case "thisweek": {
      const day = now.getDay() || 7;
      from = new Date(now);
      from.setDate(now.getDate() - day + 1);
      to = new Date(now);
      break;
    }
    case "lastweek": {
      const day = now.getDay() || 7;
      from = new Date(now);
      from.setDate(now.getDate() - day - 6);
      to = new Date(now);
      to.setDate(now.getDate() - day);
      break;
    }
    case "month":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = new Date(now);
      break;
    case "lastmonth":
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to   = new Date(now.getFullYear(), now.getMonth(), 0);
      break;
    default:
      from = new Date(now);
      from.setDate(now.getDate() - 7);
      to = new Date(now);
  }

  const fmt = d =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

  return { from: fmt(from), to: fmt(to) };
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function sendTelegram(text, imageBuffer = null) {
  const base = `https://api.telegram.org/bot${TG_TOKEN}`;

  if (imageBuffer) {
    const form = new FormData();
    form.append("chat_id", TG_CHAT_ID);
    form.append("photo", imageBuffer, { filename: "report.png", contentType: "image/png" });
    form.append("caption", text.slice(0, 1024));
    await fetch(`${base}/sendPhoto`, { method: "POST", body: form });
    return;
  }

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
    await fetch(`${base}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: TG_CHAT_ID, text: chunk, parse_mode: "Markdown" }),
    });
    await delay(400);
  }
}

async function sendTelegramKeyboard(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
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
    }),
  });
}

async function answerCallback(id) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ callback_query_id: id }),
  });
}

async function setMyCommands() {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      commands: [
        { command: "report",    description: "📊 Choose report period" },
        { command: "week",      description: "📅 Last 7 days" },
        { command: "month",     description: "📆 This month" },
        { command: "lastmonth", description: "⬅️ Last month" },
        { command: "today",     description: "📅 Today" },
      ],
    }),
  });
}

// ── Claude helpers ────────────────────────────────────────────────────────────

async function analyzeWithClaude(screenshotBase64, dateRange, mode) {
  const modeLabel = MODE_LABELS[mode] || MODE_LABELS.week;

  const prompt = `You are a business analyst for Mount Si Movers, a local moving company in Seattle/Washington State.

Analyze this Elromco CRM reports screenshot for period ${dateRange.from} to ${dateRange.to} (${modeLabel}).

FORMAT — strict Telegram formatting only:
- *bold* for numbers and labels
- Bullet points with symbol
- NO markdown tables
- NO ### headers
- Use emoji headers like: EMOJI *TITLE*

Structure your response exactly like this:

NUMBERS
- Visitors: X
- Leads: X
- Booked: X (X% conversion)
- Revenue booked: $X
- Best source: X

WORKING
1. [insight + number]
2. [insight + number]

PROBLEMS
1. [problem + number]
2. [problem + number]

ACTION THIS WEEK
1. [concrete action]
2. [concrete action]
3. [concrete action]

MONEY INSIGHT
[2-3 sentence key financial takeaway]

Use real numbers from the screenshot. Direct tone. Max 400 words.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-opus-4-5",
      max_tokens: 1500,
      messages: [{
        role:    "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: screenshotBase64 } },
          { type: "text",  text: prompt },
        ],
      }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error("Claude API: " + data.error.message);
  return data.content.map(b => b.text || "").join("");
}

async function handleQuestion(question, reportContext) {
  try {
    await sendTelegram("Thinking...");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-opus-4-5",
        max_tokens: 600,
        system: `You are a business advisor for Mount Si Movers, a moving company in Seattle.
Answer questions about their business report data. Be direct and specific.
Use Telegram formatting: *bold* for key points, bullet points.
Max 200 words. Answer in the same language as the question.`,
        messages: [{
          role:    "user",
          content: `Report:\n\n${reportContext}\n\n---\n\nQuestion: ${question}`,
        }],
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    await sendTelegram(data.content.map(b => b.text || "").join(""));
  } catch (err) {
    console.error("Q&A error:", err.message);
    await sendTelegram(`Error: ${err.message}`);
  }
}

// ── Main automation ───────────────────────────────────────────────────────────

async function runReport(mode = "week") {
  const dateRange = getDateRange(mode);
  const modeLabel = MODE_LABELS[mode] || MODE_LABELS.week;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`REPORT: ${mode} | ${dateRange.from} -> ${dateRange.to}`);
  console.log(`${"=".repeat(50)}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.setDefaultTimeout(25000);

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────────
    console.log("Logging in...");
    await page.goto(ELROMCO_URL + "/login", { waitUntil: "domcontentloaded" });
    await delay(2000);

    const allInputs = await page.locator("input").all();

    const emailInput = page.locator('input[placeholder*="email" i], input[type="email"], input[placeholder*="company" i]').first();
    if (await emailInput.count() > 0) {
      await emailInput.fill(ELROMCO_LOGIN);
    } else {
      await allInputs[0].fill(ELROMCO_LOGIN);
    }
    await delay(300);

    const passInput = page.locator('input[type="password"]').first();
    if (await passInput.count() > 0) {
      await passInput.fill(ELROMCO_PASS);
    } else {
      await allInputs[1].fill(ELROMCO_PASS);
    }
    await delay(300);

    const compInput = page.locator('input[placeholder*="company id" i], input[placeholder*="compan" i]').last();
    if (await compInput.count() > 0) {
      await compInput.click({ clickCount: 3 });
      await compInput.fill(ELROMCO_COMPID);
    } else if (allInputs.length >= 3) {
      await allInputs[2].click({ clickCount: 3 });
      await allInputs[2].fill(ELROMCO_COMPID);
    }
    await delay(300);

    await page.screenshot({ path: "/tmp/01-login.png" });

    const loginBtn = page.locator('button[type="submit"], button:has-text("Log In"), button:has-text("Login")').first();
    await loginBtn.click();
    await page.waitForLoadState("domcontentloaded");
    await delay(3000);

    const continueBtn = page.locator('button:has-text("CONTINUE"), button:has-text("Continue")').first();
    if (await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click();
      console.log("Dismissed Active Session dialog");
      await delay(2000);
    }

    console.log("Logged in:", page.url());

    // ── 2. NAVIGATE TO REPORTS ────────────────────────────────────────────────
    await page.goto(ELROMCO_URL + "/reports", { waitUntil: "domcontentloaded" });
    await delay(3000);

    if (!page.url().includes("/reports")) {
      console.log("Redirected, trying sidebar...");
      for (const y of [475, 460, 490, 450, 510]) {
        await page.mouse.click(18, y);
        await delay(2000);
        if (page.url().includes("/reports")) { break; }
      }
    }

    console.log("Reports URL:", page.url());

    // Click General Statistics tab
    const generalTab = page.locator('text="General Statistics"').first();
    if (await generalTab.count() > 0) {
      await generalTab.click();
      await delay(1500);
    }

    // Apply zoom after navigation
    await page.evaluate(() => { document.body.style.zoom = "0.75"; });
    await delay(500);
    await page.screenshot({ path: "/tmp/02-reports.png" });

    // ── 3. SELECT DATE RANGE ──────────────────────────────────────────────────
    console.log(`Setting date: ${PRESET_LABELS[mode]}`);

    const datePickerEl = page.locator('.el-date_range_input input, [data-testvalue]').first();
    if (await datePickerEl.count() > 0) {
      await datePickerEl.click();
    } else {
      await page.mouse.click(1140, 288);
    }
    await delay(1500);
    await page.screenshot({ path: "/tmp/03-calendar.png" });

    const presetBtn = page.locator(`text="${PRESET_LABELS[mode]}"`).first();
    if (await presetBtn.count() > 0) {
      await presetBtn.click();
      console.log(`Clicked: ${PRESET_LABELS[mode]}`);
    } else {
      console.log(`Preset not found: ${PRESET_LABELS[mode]}`);
    }
    await delay(2000);

    // Close calendar safely
    await page.keyboard.press("Escape");
    await delay(1500);

    // Re-apply zoom
    await page.evaluate(() => { document.body.style.zoom = "0.75"; });
    await delay(500);
    await page.screenshot({ path: "/tmp/04-dated.png" });

    // ── 4. SCROLL & SCREENSHOT ────────────────────────────────────────────────
    console.log("Scrolling to load all tables...");
    await delay(1000);

    // Safe scroll via keyboard
    await page.keyboard.press("Tab");
    await delay(300);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("PageDown");
      await delay(350);
    }
    await delay(2000);

    const bottomBuffer = await page.screenshot({ path: "/tmp/05-bottom.png" });
    console.log("Bottom screenshot taken");

    await page.keyboard.press("Control+Home");
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(1000);

    const fullPageBuffer = await page.screenshot({ path: "/tmp/06-full.png", fullPage: true });
    console.log("Full screenshot taken");

    // ── 5. ANALYZE ────────────────────────────────────────────────────────────
    console.log("Analyzing with Claude...");
    const analysis = await analyzeWithClaude(fullPageBuffer.toString("base64"), dateRange, mode);
    console.log("Analysis received");

    // ── 6. SEND ───────────────────────────────────────────────────────────────
    const header = `*Mount Si Movers — Business Report*\n${modeLabel}: ${dateRange.from} -> ${dateRange.to}\n\n`;
    // Send top screenshot
    await sendTelegram(`Report (${dateRange.from} -> ${dateRange.to}) — top`, fullPageBuffer);
    await delay(800);

    // Send bottom screenshot with tables (from memory, not disk)
    await sendTelegram(`Tables: Assignment, Source, Move Type`, bottomBuffer);
    await delay(800);

    // Send analysis
    await sendTelegram(header + analysis);

    console.log("Report sent!");
    return { success: true, mode, dateRange };

  } catch (err) {
    console.error("ERROR:", err.message);
    try { await page.screenshot({ path: "/tmp/error.png" }); } catch {}
    await sendTelegram(`Report error (${mode}): ${err.message}`).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

// ── Telegram polling ──────────────────────────────────────────────────────────

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

        if (update.callback_query) {
          const mode = update.callback_query.data;
          await answerCallback(update.callback_query.id);
          if (ALLOWED_MODES.includes(mode)) {
            await sendTelegram(`Running ${MODE_LABELS[mode]} report... ~2 min.`);
            runReport(mode).catch(e => {
              console.error("Report error:", e.message);
              sendTelegram(`Report failed: ${e.message}`).catch(() => {});
            });
          }
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
          await sendTelegram(`Running ${MODE_LABELS[cmd]} report... ~2 min.`);
          runReport(cmd).catch(e => {
            console.error("Report error:", e.message);
            sendTelegram(`Report failed: ${e.message}`).catch(() => {});
          });
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
  const schedule = require("node-schedule");
  schedule.scheduleJob("0 16 * * 1", () => runReport("week").catch(e => console.error(e.message)));
  schedule.scheduleJob("0 16 1 * *", () => runReport("month").catch(e => console.error(e.message)));
  console.log("Scheduler: Mon 8am PT + 1st of month 8am PT");
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({
  status:  "ok",
  service: "Elromco Analytics Bot v2",
  modes:   ALLOWED_MODES,
}));

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.get("/run/:mode", (req, res) => {
  const { mode } = req.params;
  if (!ALLOWED_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${ALLOWED_MODES.join(", ")}` });
  }
  res.json({ status: "started", mode });
  runReport(mode).catch(e => console.error("Manual run error:", e.message));
});

app.get("/screenshot/:name", (req, res) => {
  const file = `/tmp/${req.params.name}.png`;
  if (fs.existsSync(file)) {
    res.setHeader("Content-Type", "image/png");
    res.send(fs.readFileSync(file));
  } else {
    const available = fs.readdirSync("/tmp").filter(f => f.endsWith(".png"));
    res.status(404).json({ error: "Not found", available });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\nElromco Analytics Bot v2 on port ${PORT}`);
  startScheduler();
  setMyCommands().catch(e => console.error("setMyCommands:", e.message));
  startTelegramPolling().catch(e => console.error("Polling crashed:", e.message));
  await sendTelegram("Moving Analyzer Bot is online. Use /report to get started.").catch(() => {});
  await sendTelegramKeyboard("Choose a report period:").catch(() => {});
});
