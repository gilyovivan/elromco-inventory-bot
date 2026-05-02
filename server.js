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
  await page.setViewportSize({ width: 1440, height: 900 });
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
    await page.screenshot({ path: "/tmp/report-01-loaded.png" });

    // ── 3. SELECT DATE RANGE via preset buttons ───────────────────────────────
    console.log(`📅 Setting date range for mode: ${mode}`);

    // Click the date picker area to open calendar
    const datePicker = page.locator('[class*="date"], [class*="Date"], text=/\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}/').first();
    if (await datePicker.count() > 0) {
      await datePicker.click();
      await delay(1000);
    } else {
      // Click by coordinates — date range is top right corner around x=1290, y=205
      await page.mouse.click(1290, 205);
      await delay(1000);
    }

    await page.screenshot({ path: "/tmp/report-02-calendar-open.png" });

    // Click the preset button based on mode
    const presetMap = {
      week:     ["Last 7 Days", "Last7Days", "Last 7"],
      month:    ["This Month", "ThisMonth"],
      lastweek: ["Last Week", "LastWeek"],
      lastmonth:["Last Month", "LastMonth"],
    };

    const presets = presetMap[mode] || presetMap.week;
    let presetClicked = false;

    for (const label of presets) {
      const btn = page.locator(`text="${label}", button:has-text("${label}")`).first();
      if (await btn.count() > 0) {
        await btn.click();
        await delay(2000);
        console.log(`✅ Clicked preset: ${label}`);
        presetClicked = true;
        break;
      }
    }

    if (!presetClicked) {
      console.log("⚠️ Preset button not found — using current date range");
      // Close calendar by pressing Escape
      await page.keyboard.press("Escape");
      await delay(500);
    }

    await page.screenshot({ path: "/tmp/report-02-dated.png" });
    console.log("📸 Date range set");



    // ── 4. SCROLL & SCREENSHOT ALL SECTIONS ──────────────────────────────────
    console.log("📸 Taking full-page screenshot...");

    // Wait for data to load
    await delay(2000);

    // Take full page screenshot
    const fullPageBuffer = await page.screenshot({ path: "/tmp/report-03-full.png", fullPage: true });
    console.log("✅ Full page screenshot taken");

    // Also screenshot individual sections if they exist
    const sections = [
      { name: "assignment",  selector: 'text=Assignment' },
      { name: "source",      selector: 'text=Source' },
      { name: "movetype",    selector: 'text=Move Type' },
      { name: "sizofmove",   selector: 'text=Size of Move' },
    ];

    const sectionScreenshots = [];
    for (const sec of sections) {
      const el = page.locator(sec.selector).first();
      if (await el.count() > 0) {
        try {
          await el.scrollIntoViewIfNeeded();
          await delay(400);
          const buf = await page.screenshot({ path: `/tmp/report-${sec.name}.png` });
          sectionScreenshots.push({ name: sec.name, buffer: buf });
          console.log(`✅ Captured section: ${sec.name}`);
        } catch (e) {
          console.log(`⚠️ Couldn't capture ${sec.name}: ${e.message}`);
        }
      }
    }

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

app.listen(PORT, () => {
  console.log(`\n🤖 Elromco Analytics Bot running on port ${PORT}`);
  console.log(`📡 GET /run/week  — weekly report`);
  console.log(`📡 GET /run/month — monthly report`);
  startScheduler();
});
