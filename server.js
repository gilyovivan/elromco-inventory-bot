const express    = require("express");
const { chromium } = require("playwright");

const app  = express();
app.use(express.json({ limit: "10mb" }));

// ── Config (set as env vars on Railway) ──────────────────────────────────────
const ELROMCO_URL    = "https://app.elromco.com";
const ELROMCO_LOGIN  = process.env.ELROMCO_LOGIN  || "bot";
const ELROMCO_PASS   = process.env.ELROMCO_PASS   || "botbot";
const ELROMCO_COMPID = process.env.ELROMCO_COMPID || "153";
const PORT           = process.env.PORT || 3000;

// Room name mapping: AI names → Elromco sidebar names
const ROOM_MAP = {
  "living room":  "Living Room",
  "bedroom":      "Bedroom",
  "kitchen":      "Kitchen",
  "dining room":  "Dining Room",
  "office":       "Office",
  "bathroom":     "Other",
  "storage":      "Other",
  "other":        "Other",
};

function mapRoom(name) {
  return ROOM_MAP[name.toLowerCase()] || "Other";
}

// ── Delay helper ──────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Main automation function ──────────────────────────────────────────────────
async function fillInventory(reservationId, categories) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────────
    console.log("🔐 Logging in...");
    await page.goto(ELROMCO_URL + "/login");
    await page.waitForLoadState("networkidle");

    // Fill login form
    await page.fill('input[type="text"], input[name="login"], input[placeholder*="ogin" i]', ELROMCO_LOGIN);
    await page.fill('input[type="password"]', ELROMCO_PASS);

    // Submit - try button click or Enter
    const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")').first();
    if (await loginBtn.count() > 0) {
      await loginBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForLoadState("networkidle");
    await delay(2000);
    console.log("✅ Logged in, URL:", page.url());

    // ── 2. SEARCH FOR RESERVATION ─────────────────────────────────────────────
    console.log(`🔍 Searching for ${reservationId}...`);

    // Click search icon
    const searchIcon = page.locator('[data-testid="SearchIcon"], [aria-label="search" i], button:has(svg)').first();
    await searchIcon.click();
    await delay(1000);

    // Type reservation ID
    const searchInput = page.locator('input[placeholder*="earch" i]').first();
    await searchInput.fill(reservationId);
    await delay(2000);

    // Click result that matches "Order Number"
    // Look for the result with exact order number match
    const orderResult = page.locator(`text=${reservationId}`).first();
    await orderResult.waitFor({ timeout: 10000 });
    await orderResult.click();
    await delay(2000);
    console.log("✅ Opened reservation", reservationId);

    // ── 3. OPEN INVENTORY ─────────────────────────────────────────────────────
    console.log("📋 Opening inventory...");

    // Click three dots menu
    const moreBtn = page.locator('[aria-label="more" i], button:has([data-testid="MoreVertIcon"])').first();
    await moreBtn.click();
    await delay(800);

    // Click Inventory option
    await page.locator('text=Inventory').click();
    await delay(2000);
    console.log("✅ Inventory opened");

    // ── 4. FILL ITEMS PER ROOM ───────────────────────────────────────────────
    for (const cat of categories) {
      if (!cat.items?.length) continue;

      const roomName = mapRoom(cat.name);
      console.log(`\n🏠 Room: ${cat.name} → ${roomName}`);

      for (const item of cat.items) {
        // Repeat for quantity (add item quantity times)
        for (let q = 0; q < item.quantity; q++) {
          console.log(`  ➕ Adding: ${item.name} (${q+1}/${item.quantity})`);

          // Click SELECT A ROOM
          const selectRoomBtn = page.locator('button:has-text("SELECT A ROOM"), text=SELECT A ROOM').first();
          await selectRoomBtn.click();
          await delay(800);

          // Click the room in sidebar
          await page.locator(`text=${roomName}`).first().click();
          await delay(600);

          // Click + button (Add Custom Item)
          const plusBtn = page.locator('button:has-text("+"), [aria-label="add" i]').first();
          await plusBtn.click();
          await delay(800);

          // Fill "Add Custom Item" form
          // Item Name
          const nameInput = page.locator('input[placeholder*="name" i], label:has-text("Item Name") + input, label:has-text("Item Name") ~ input').first();
          await nameInput.fill(item.name);

          // Quantity — set to 1 (we loop for quantity)
          const qtyInput = page.locator('input[placeholder*="uantity" i], label:has-text("Quantity") + input, label:has-text("Quantity") ~ input').first();
          await qtyInput.triple_click();
          await qtyInput.fill("1");

          // Select "Define volume" radio if not already selected
          const volumeRadio = page.locator('text=Define volume').first();
          if (await volumeRadio.count() > 0) await volumeRadio.click();
          await delay(300);

          // Cubic Feet
          const cuftInput = page.locator('input[placeholder*="ubic" i], label:has-text("Cubic Feet") + input, label:has-text("Cubic Feet") ~ input').first();
          await cuftInput.triple_click();
          await cuftInput.fill(String(item.cu_ft || 0));

          // Pounds
          const lbsInput = page.locator('input[placeholder*="ound" i], label:has-text("Pounds") + input, label:has-text("Pounds") ~ input').first();
          await lbsInput.triple_click();
          await lbsInput.fill(String(item.weight_lbs || 0));

          // Click SAVE
          await page.locator('button:has-text("SAVE"), button:has-text("Save")').first().click();
          await delay(1000);

          console.log(`  ✅ Saved: ${item.name}`);
        }
      }
    }

    // ── 5. SUBMIT INVENTORY ───────────────────────────────────────────────────
    console.log("\n📤 Submitting inventory...");
    const submitBtn = page.locator('button:has-text("SUBMIT"), button:has-text("Submit")').first();
    await submitBtn.click();
    await delay(2000);

    // Confirm if dialog appears
    const confirmBtn = page.locator('button:has-text("CONFIRM"), button:has-text("Confirm"), button:has-text("YES"), button:has-text("Yes")').first();
    if (await confirmBtn.count() > 0) {
      await confirmBtn.click();
      await delay(1000);
    }

    console.log("✅ Inventory submitted successfully!");
    return { success: true, message: "Inventory submitted to Elromco" };

  } catch (err) {
    console.error("❌ Error:", err.message);

    // Take screenshot for debugging
    try {
      await page.screenshot({ path: `/tmp/error-${Date.now()}.png` });
    } catch {}

    throw err;
  } finally {
    await browser.close();
  }
}

// ── Express routes ────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Elromco Inventory Bot" });
});

// Main endpoint — called from your HTML tool after user submits
app.post("/fill-inventory", async (req, res) => {
  const { reservation_id, categories } = req.body;

  if (!reservation_id) {
    return res.status(400).json({ error: "reservation_id is required" });
  }
  if (!categories?.length) {
    return res.status(400).json({ error: "categories is required" });
  }

  console.log(`\n🚀 Starting inventory fill for ${reservation_id}`);
  console.log(`📦 Categories: ${categories.length}, Items: ${categories.reduce((a,c)=>a+c.items.length,0)}`);

  try {
    const result = await fillInventory(reservation_id, categories);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🤖 Elromco Bot running on port ${PORT}`);
  console.log(`📡 POST /fill-inventory to start automation`);
});
