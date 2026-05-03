const express      = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const ELROMCO_URL    = "https://app.elromco.com";
const ELROMCO_LOGIN  = process.env.ELROMCO_LOGIN  || "";
const ELROMCO_PASS   = process.env.ELROMCO_PASS   || "";
const ELROMCO_COMPID = process.env.ELROMCO_COMPID || "153";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || "";
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID || "";
const PORT           = process.env.PORT || 3000;

const delay = ms => new Promise(r => setTimeout(r, ms));
const fs    = require("fs");

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateRange(mode = "week") {
  const now   = new Date();
  const toDate = new Date(now);

  let fromDate;
  if (mode === "week") {
    fromDate = new Date(now);
    fromDate.setDate(now.getDate() - 7);
  } else if (mode === "month") {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (mode === "lastweek") {
    // Mon-Sun of previous week
    const day = now.getDay() || 7;
    fromDate  = new Date(now);
    fromDate.setDate(now.getDate() - day - 6);
    toDate.setDate(now.getDate() - day);
  }

  const fmt = d =>
    `${String(d.getMonth() + 1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;

  return { from: fmt(fromDate), to: fmt(toDate), fromDate, toDate };
}

async function sendTelegram(text, imageBuffer = null) {
  const base = `https://api.telegram.org/bot${TG_TOKEN}`;

  if (imageBuffer) {
    const FormData = require("form-data");
    const form     = new FormData();
    form.append("chat_id", TG_CHAT_ID);
    form.append("photo",   imageBuffer, { filename: "report.png", contentType: "image/png" });
    form.append("caption", text.slice(0, 1024));

    const fetch = require("node-fetch");
    await fetch(`${base}/sendPhoto`, { method: "POST", body: form });
  } else {
    const fetch = require("node-fetch");
    // Split long messages (Telegram limit = 4096)
    const chunks = [];
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
    for (const chunk of chunks) {
      await fetch(`${base}/sendMessage`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ chat_id: TG_CHAT_ID, text: chunk, parse_mode: "Markdown" }),
      });
      await delay(300);
    }
  }
}

async function analyzeWithClaude(screenshotBase64, dateRange, mode) {
  const fetch = require("node-fetch");

  const prompt = `You are a business analyst for Mount Si Movers, a local moving company in Seattle/Washington State.

Analyze this screenshot from their Elromco CRM reports dashboard for the period ${dateRange.from} to ${dateRange.to}.

Extract ALL numbers you can read and provide:

1. **📊 KEY NUMBERS** — list every metric you can read (revenue, orders, conversion rates, lead sources, crew performance, move types)

2. **✅ WHAT'S WORKING** — 2-3 specific things performing well with exact numbers

3. **⚠️ PROBLEMS** — 2-3 specific issues or underperformers with exact numbers

4. **💡 ACTION ITEMS** — 3 concrete things the owner should do THIS WEEK based on the data

5. **💰 MONEY INSIGHT** — one key financial insight (e.g. best/worst lead source ROI, most profitable move type)

Be specific and direct. Use the actual numbers from the screenshot. Write in a friendly but professional tone — like a smart business advisor texting the owner. Use emojis sparingly. Keep total response under 800 words.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
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
          {
            type:   "image",
            source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
          },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error("Claude API: " + data.error.message);
  return data.content.map(b => b.text || "").join("");
}

// ── Main automation ───────────────────────────────────────────────────────────

async function runReport(mode = "week") {
  const dateRange = getDateRange(mode);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 REPORT: ${mode} | ${dateRange.from} → ${dateRange.to}`);
  console.log(`${"=".repeat(50)}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  // Zoom out to 75% — more content fits per screenshot
  await page.evaluate(() => { document.body.style.zoom = "0.75"; });
  page.setDefaultTimeout(25000);

  try {
    // ── 1. LOGIN (same as inventory bot) ─────────────────────────────────────
    console.log("🔐 Logging in...");
    await page.goto(ELROMCO_URL + "/login", { waitUntil: "domcontentloaded" });
    await delay(2000);

    // Log all inputs for debug
    const allInputs = await page.locator("input").all();
    console.log(`🔍 Found ${allInputs.length} inputs on login page`);
    for (let i = 0; i < allInputs.length; i++) {
      const type = await allInputs[i].getAttribute("type").catch(() => "");
      const name = await allInputs[i].getAttribute("name").catch(() => "");
      const ph   = await allInputs[i].getAttribute("placeholder").catch(() => "");
      console.log(`  input[${i}]: type=${type} name=${name} placeholder=${ph}`);
    }

    // Fill by placeholder text — most reliable
    const emailInput = page.locator('input[placeholder*="company" i], input[placeholder*="email" i], input[type="email"]').first();
    const passInput  = page.locator('input[type="password"]').first();
    const compInput  = page.locator('input[placeholder*="company id" i], input[placeholder*="compan" i]').last();

    if (await emailInput.count() > 0) {
      await emailInput.click();
      await emailInput.fill(ELROMCO_LOGIN);
      console.log("✅ Filled email via placeholder");
    } else {
      await allInputs[0].click();
      await allInputs[0].fill(ELROMCO_LOGIN);
      console.log("✅ Filled email via index 0");
    }
    await delay(500);

    if (await passInput.count() > 0) {
      await passInput.click();
      await passInput.fill(ELROMCO_PASS);
      console.log("✅ Filled password");
    } else {
      await allInputs[1].click();
      await allInputs[1].fill(ELROMCO_PASS);
      console.log("✅ Filled password via index 1");
    }
    await delay(500);

    // Company ID — clear first then fill
    if (await compInput.count() > 0) {
      await compInput.click();
      await compInput.selectText().catch(() => {});
      await compInput.fill(ELROMCO_COMPID);
      console.log("✅ Filled company ID via placeholder");
    } else if (allInputs.length >= 3) {
      await allInputs[2].click();
      await allInputs[2].selectText().catch(() => {});
      await allInputs[2].fill(ELROMCO_COMPID);
      console.log("✅ Filled company ID via index 2");
    }
    await delay(500);

    await page.screenshot({ path: "/tmp/login-filled.png" });
    console.log("📸 Login filled screenshot saved");

    const loginBtn = page.locator('button[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign")').first();
    await loginBtn.click();
    await page.waitForLoadState("domcontentloaded");
    await delay(3000);

    // Handle Active Session dialog
    const continueBtn = page.locator('button:has-text("CONTINUE"), button:has-text("Continue")').first();
    if (await continueBtn.isVisible().catch(() => false)) {
      await continueBtn.click();
      console.log("✅ Dismissed Active Session dialog");
      await delay(2000);
    }

    console.log("✅ Logged in. URL:", page.url());

    // ── 2. NAVIGATE TO REPORTS via sidebar ──────────────────────────────────
    console.log("📈 Navigating to reports...");
    await delay(2000);
    await page.screenshot({ path: "/tmp/report-00-after-login.png" });

    // Try direct URL
    await page.goto(ELROMCO_URL + "/reports", { waitUntil: "domcontentloaded" });
    await delay(3000);

    // If redirected — click sidebar icon by coordinates
    // From screenshot: left sidebar x=18, reports (chart) icon at y=475
    if (!page.url().includes("/reports")) {
      console.log("⚠️ Redirected, clicking sidebar reports icon...");
      for (const y of [475, 460, 490, 450, 510]) {
        await page.mouse.click(18, y);
        await delay(2000);
        if (page.url().includes("/reports")) {
          console.log(`✅ Reports opened at y=${y}`);
          break;
        }
      }
    }

    await delay(2000);
    console.log("📍 URL:", page.url());
    // Re-apply zoom after page load
    await page.evaluate(() => { document.body.style.zoom = "0.75"; });
    await delay(500);
    await page.screenshot({ path: "/tmp/report-01-loaded.png" });

    // ── 3. SELECT DATE RANGE via preset buttons ───────────────────────────────
    console.log(`📅 Setting date range for mode: ${mode}`);

    // Click date picker using exact MUI selector from HTML inspection
    console.log("📅 Clicking date picker...");

    const datePickerEl = page.locator('.el-date_range_input input, [data-testvalue]').first();
    if (await datePickerEl.count() > 0) {
      await datePickerEl.click();
      console.log("✅ Clicked date picker via MUI selector");
    } else {
      await page.mouse.click(1140, 288);
      console.log("✅ Clicked date picker via coords fallback");
    }
    await delay(2000);
    await page.screenshot({ path: "/tmp/report-02-calendar-open.png" });
    console.log("📸 Calendar open screenshot saved");

    // Click preset button by text
    const presetLabels = {
      week:      "Last 7 Days",
      month:     "This Month",
      lastweek:  "Last Week",
      lastmonth: "Last Month",
    };
    const presetLabel = presetLabels[mode] || "Last 7 Days";

    const presetBtn = page.locator(`text="${presetLabel}"`).first();
    if (await presetBtn.count() > 0) {
      await presetBtn.click();
      console.log(`✅ Clicked preset: ${presetLabel}`);
    } else {
      console.log(`⚠️ Preset not found — check report-02-calendar-open screenshot`);
    }
    await delay(2000);

    // Close calendar by pressing Escape and clicking outside
    await page.keyboard.press("Escape");
    await delay(500);
    await page.mouse.click(400, 150); // click away from calendar
    await delay(1500);

    await page.screenshot({ path: "/tmp/report-02-dated.png" });
    console.log("📸 Date range set");



    // ── 4. SCROLL TO BOTTOM & SCREENSHOT ────────────────────────────────────
    console.log("📸 Scrolling to load all content...");
    await delay(2000);

    // Click on page body to ensure focus, then scroll
    await page.mouse.click(700, 400);
    await delay(500);

    // Scroll using mouse wheel simulation
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 400);
      await delay(300);
    }
    await delay(3000); // wait for tables to render

    // Screenshot at bottom
    await page.screenshot({ path: "/tmp/report-04-bottom.png" });
    console.log("✅ Bottom screenshot taken");

    // Scroll back to top
    await page.evaluate(() => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await delay(1500);

    // Full page screenshot
    const fullPageBuffer = await page.screenshot({ path: "/tmp/report-03-full.png", fullPage: true });
    console.log("✅ Full page screenshot taken");

    // ── 5. ANALYZE WITH CLAUDE ───────────────────────────────────────────────
    console.log("🧠 Sending to Claude for analysis...");

    const screenshotBase64 = fullPageBuffer.toString("base64");
    const analysis = await analyzeWithClaude(screenshotBase64, dateRange, mode);
    console.log("✅ Analysis received");

    // ── 6. SEND TO TELEGRAM ──────────────────────────────────────────────────
    console.log("📱 Sending to Telegram...");

    const modeLabel = mode === "week" ? "📅 Last 7 Days" : mode === "month" ? "📆 This Month" : "📅 Last Week";
    const header = `*Mount Si Movers — Business Report*\n${modeLabel}: ${dateRange.from} → ${dateRange.to}\n\n`;

    // Send screenshot first
    await sendTelegram(`📊 Report screenshot (${dateRange.from} → ${dateRange.to})`, fullPageBuffer);
    await delay(1000);

    // Send analysis text
    await sendTelegram(header + analysis);

    console.log("✅ Report sent to Telegram!");
    return { success: true, mode, dateRange };

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    try { await page.screenshot({ path: "/tmp/report-error.png" }); } catch {}

    // Notify via Telegram about error
    await sendTelegram(`❌ *Report bot error*\n\`${err.message}\`\nCheck Railway logs.`).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    console.log("🔒 Browser closed");
  }
}

// ── Telegram Bot Commands ────────────────────────────────────────────────────

async function sendTelegramKeyboard(text) {
  const fetch = require("node-fetch");
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📅 Last 7 Days", callback_data: "week" },
            { text: "📆 This Month",  callback_data: "month" },
          ],
          [
            { text: "⬅️ Last Week",  callback_data: "lastweek" },
            { text: "⬅️ Last Month", callback_data: "lastmonth" },
          ],
        ],
      },
    }),
  });
}

async function answerCallback(callbackQueryId) {
  const fetch = require("node-fetch");
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function setMyCommands() {
  const fetch = require("node-fetch");
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "report", description: "📊 Get a business report" },
        { command: "week",   description: "📅 Last 7 days report" },
        { command: "month",  description: "📆 This month report" },
      ],
    }),
  });
}

// Long-polling for Telegram updates
async function startTelegramPolling() {
  const fetch = require("node-fetch");
  let offset = 0;
  console.log("🤖 Telegram polling started...");

  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&timeout=30`
      );
      const data = await res.json();

      if (!data.ok) { await delay(5000); continue; }

      for (const update of data.result) {
        offset = update.update_id + 1;

        // Handle button presses
        if (update.callback_query) {
          const mode = update.callback_query.data;
          const allowed = ["week", "month", "lastweek", "lastmonth"];
          await answerCallback(update.callback_query.id);
          if (allowed.includes(mode)) {
            await sendTelegram(`⏳ Running *${mode}* report... Check back in ~2 min.`);
            runReport(mode).catch(e => console.error("Report error:", e.message));
          }
          continue;
        }

        // Handle text commands
        const text = update.message?.text || "";
        const chatId = update.message?.chat?.id;
        if (!text.startsWith("/")) continue;

        const cmd = text.split(" ")[0].replace("/", "").replace(`@${process.env.BOT_USERNAME || ""}`, "");

        if (cmd === "start" || cmd === "report") {
          await sendTelegramKeyboard(`📊 *Mount Si Movers Analytics*

Choose a report period:`);
        } else if (["week", "month", "lastweek", "lastmonth"].includes(cmd)) {
          await sendTelegram(`⏳ Running *${cmd}* report... ~2 min.`);
          runReport(cmd).catch(e => console.error("Report error:", e.message));
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

  // Every Monday at 8:00 AM Pacific = 16:00 UTC
  schedule.scheduleJob("0 16 * * 1", async () => {
    console.log("⏰ Scheduled weekly report triggered");
    try { await runReport("week"); }
    catch (e) { console.error("Scheduler error:", e.message); }
  });

  // Every 1st of month at 8:00 AM Pacific
  schedule.scheduleJob("0 16 1 * *", async () => {
    console.log("⏰ Scheduled monthly report triggered");
    try { await runReport("month"); }
    catch (e) { console.error("Scheduler error:", e.message); }
  });

  console.log("⏰ Scheduler started: weekly Mon 8am PT, monthly 1st 8am PT");
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status:   "ok",
    service:  "Elromco Analytics Bot v1",
    endpoints: {
      "GET  /run/:mode":    "Run report manually (mode: week | month | lastweek)",
      "GET  /screenshot/:name": "View debug screenshot",
      "GET  /health":       "Health check",
    },
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// Manual trigger — just open URL in browser
app.get("/run/:mode", async (req, res) => {
  const mode = req.params.mode || "week";
  const allowed = ["week", "month", "lastweek"];
  if (!allowed.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${allowed.join(", ")}` });

  console.log(`\n🔘 Manual trigger: /run/${mode}`);
  res.json({ status: "started", mode, message: "Report is running. Check Telegram in ~2 minutes." });

  // Run async after response
  runReport(mode).catch(e => console.error("Manual run error:", e.message));
});

// View debug screenshots
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
  console.log(`\n🤖 Elromco Analytics Bot running on port ${PORT}`);
  console.log(`📡 GET /run/week  — weekly report`);
  console.log(`📡 GET /run/month — monthly report`);
  startScheduler();
  setMyCommands().then(() => console.log("✅ Telegram commands registered"));
  startTelegramPolling().catch(e => console.error("Polling crashed:", e.message));

  // Notify on startup
  await sendTelegram(`✅ *Moving Analyzer Bot is online*\n\nReady to run reports. Use the buttons below or tap /report`, ).catch(() => {});
  await sendTelegramKeyboard(`📊 Choose a report period:`).catch(() => {});
});
