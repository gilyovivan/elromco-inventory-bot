const express      = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const ELROMCO_URL    = "https://app.elromco.com";
const ELROMCO_LOGIN  = process.env.ELROMCO_LOGIN  || "bot";
const ELROMCO_PASS   = process.env.ELROMCO_PASS   || "botbot";
const ELROMCO_COMPID = process.env.ELROMCO_COMPID || "153";
const PORT           = process.env.PORT || 3000;

const ROOM_MAP = {
  "living room": "Living Room",
  "bedroom":     "Bedroom",
  "kitchen":     "Kitchen",
  "dining room": "Dining Room",
  "office":      "Office",
  "bathroom":    "Other",
  "storage":     "Other",
  "other":       "Other",
};
function mapRoom(n) { return ROOM_MAP[n.toLowerCase()] || "Other"; }
const delay = ms => new Promise(r => setTimeout(r, ms));

async function fillInventory(reservationId, categories) {
  console.log("🌐 Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);

  // Log all console errors from the page
  page.on("pageerror", err => console.log("PAGE ERROR:", err.message));

  try {
    // ── 1. LOGIN ────────────────────────────────────────────────────────────
    console.log("🔐 Navigating to login...");
    await page.goto(ELROMCO_URL + "/login", { waitUntil: "domcontentloaded" });
    await delay(2000);
    console.log("📍 URL after goto:", page.url());
    console.log("📄 Page title:", await page.title());

    // Screenshot for debug
    await page.screenshot({ path: "/tmp/01-login.png", fullPage: false });
    console.log("📸 Screenshot saved: 01-login.png");

    // Find and fill inputs
    const inputs = await page.locator("input").all();
    console.log(`🔍 Found ${inputs.length} inputs on login page`);
    for (let i = 0; i < inputs.length; i++) {
      const type = await inputs[i].getAttribute("type");
      const name = await inputs[i].getAttribute("name");
      const ph   = await inputs[i].getAttribute("placeholder");
      console.log(`  Input[${i}]: type=${type} name=${name} placeholder=${ph}`);
    }

    // Fill login - try multiple selectors
    try {
      await page.fill('input[type="text"]', ELROMCO_LOGIN);
      console.log("✅ Filled text input with login");
    } catch {
      try {
        await page.fill('input[name="login"]', ELROMCO_LOGIN);
        console.log("✅ Filled name=login input");
      } catch {
        await page.locator("input").first().fill(ELROMCO_LOGIN);
        console.log("✅ Filled first input with login");
      }
    }

    // Company ID if needed
    const allInputs = await page.locator("input").all();
    if (allInputs.length >= 3) {
      await allInputs[1].fill(ELROMCO_COMPID);
      console.log("✅ Filled company ID");
      await allInputs[2].fill(ELROMCO_PASS);
      console.log("✅ Filled password (3rd input)");
    } else {
      await page.fill('input[type="password"]', ELROMCO_PASS);
      console.log("✅ Filled password input");
    }

    await page.screenshot({ path: "/tmp/02-filled.png" });
    console.log("📸 Screenshot: 02-filled.png");

    // Submit
    const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign"), button:has-text("Enter")').first();
    const btnCount = await loginBtn.count();
    console.log(`🔍 Found ${btnCount} login buttons`);
    if (btnCount > 0) {
      await loginBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }
    console.log("🖱️ Clicked login");

    await page.waitForLoadState("domcontentloaded");
    await delay(3000);
    console.log("📍 URL after login:", page.url());
    await page.screenshot({ path: "/tmp/03-after-login.png" });
    console.log("📸 Screenshot: 03-after-login.png");

    // ── 2. SEARCH ────────────────────────────────────────────────────────────
    console.log(`🔍 Searching for ${reservationId}...`);

    // Look for search icon/button
    const searchBtns = await page.locator('[aria-label*="search" i], [data-testid*="search" i], button:has(svg)').all();
    console.log(`🔍 Found ${searchBtns.length} potential search buttons`);

    // Click search icon
    const searchIcon = page.locator('[aria-label*="search" i], [data-testid="SearchIcon"]').first();
    if (await searchIcon.count() > 0) {
      await searchIcon.click();
      console.log("✅ Clicked search icon");
    } else {
      // Try clicking magnifier svg button
      await page.locator("button").first().click();
      console.log("✅ Clicked first button as search");
    }
    await delay(1000);
    await page.screenshot({ path: "/tmp/04-search-open.png" });

    // Type in search
    const searchInput = page.locator('input[placeholder*="earch" i], input[type="search"]').first();
    await searchInput.waitFor({ timeout: 5000 });
    await searchInput.fill(reservationId);
    console.log(`✅ Typed ${reservationId} in search`);
    await delay(2000);
    await page.screenshot({ path: "/tmp/05-search-results.png" });

    // Click matching result — find one with "Order Number" badge or exact match
    const results = await page.locator(`text=${reservationId}`).all();
    console.log(`🔍 Found ${results.length} results matching ${reservationId}`);
    await results[0].click();
    await delay(2000);
    console.log("✅ Clicked reservation result");
    await page.screenshot({ path: "/tmp/06-reservation.png" });

    // ── 3. OPEN INVENTORY ────────────────────────────────────────────────────
    console.log("📋 Opening inventory menu...");
    const moreBtn = page.locator('[aria-label="more" i], [data-testid="MoreVertIcon"], button:has([data-testid="MoreVertIcon"])').first();
    await moreBtn.waitFor({ timeout: 10000 });
    await moreBtn.click();
    await delay(800);
    await page.screenshot({ path: "/tmp/07-menu-open.png" });

    await page.locator('li:has-text("Inventory"), text=Inventory').first().click();
    await delay(2000);
    console.log("✅ Inventory opened");
    await page.screenshot({ path: "/tmp/08-inventory.png" });

    // ── 4. ADD ITEMS ─────────────────────────────────────────────────────────
    let totalAdded = 0;

    for (const cat of categories) {
      if (!cat.items?.length) continue;
      const roomName = mapRoom(cat.name);
      console.log(`\n🏠 Processing room: ${cat.name} → ${roomName}`);

      for (const item of cat.items) {
        console.log(`  ➕ Adding: ${item.name} x${item.quantity}`);

        // Click SELECT A ROOM
        const selectRoom = page.locator('text=SELECT A ROOM, button:has-text("SELECT A ROOM")').first();
        await selectRoom.waitFor({ timeout: 10000 });
        await selectRoom.click();
        await delay(800);

        // Click room name in sidebar
        await page.locator(`text=${roomName}`).first().click();
        await delay(600);

        // Click + (Add Custom Item button)
        const plusBtn = page.locator('button:has-text("+")').first();
        await plusBtn.waitFor({ timeout: 5000 });
        await plusBtn.click();
        await delay(800);

        await page.screenshot({ path: `/tmp/09-add-form.png` });

        // Fill form fields
        const formInputs = await page.locator('input').all();
        console.log(`    📝 Form has ${formInputs.length} inputs`);

        // Item Name
        const nameField = page.locator('input[placeholder*="name" i], label:has-text("Item Name") ~ * input, label:has-text("Item Name") + input').first();
        if (await nameField.count() > 0) {
          await nameField.fill(item.name);
        } else {
          await formInputs[0].fill(item.name);
        }
        console.log(`    ✅ Name: ${item.name}`);

        // Quantity
        const qtyField = page.locator('label:has-text("Quantity") ~ * input, label:has-text("Quantity") + input').first();
        if (await qtyField.count() > 0) {
          await qtyField.triple_click();
          await qtyField.fill(String(item.quantity));
        } else if (formInputs.length > 1) {
          await formInputs[1].triple_click();
          await formInputs[1].fill(String(item.quantity));
        }
        console.log(`    ✅ Qty: ${item.quantity}`);

        // Click "Define volume" radio
        const volumeRadio = page.locator('text=Define volume').first();
        if (await volumeRadio.count() > 0) await volumeRadio.click();
        await delay(300);

        // Cu Ft
        const cuftField = page.locator('label:has-text("Cubic") ~ * input, label:has-text("Cubic") + input').first();
        if (await cuftField.count() > 0) {
          await cuftField.triple_click();
          await cuftField.fill(String(item.cu_ft || 0));
        } else if (formInputs.length > 2) {
          await formInputs[2].triple_click();
          await formInputs[2].fill(String(item.cu_ft || 0));
        }
        console.log(`    ✅ Cu Ft: ${item.cu_ft}`);

        // Pounds
        const lbsField = page.locator('label:has-text("Pound") ~ * input, label:has-text("Pound") + input').first();
        if (await lbsField.count() > 0) {
          await lbsField.triple_click();
          await lbsField.fill(String(item.weight_lbs || 0));
        } else if (formInputs.length > 3) {
          await formInputs[3].triple_click();
          await formInputs[3].fill(String(item.weight_lbs || 0));
        }
        console.log(`    ✅ Lbs: ${item.weight_lbs}`);

        // SAVE
        await page.locator('button:has-text("SAVE"), button:has-text("Save")').first().click();
        await delay(1000);
        totalAdded++;
        console.log(`    💾 Saved! (total: ${totalAdded})`);
      }
    }

    // ── 5. SUBMIT ────────────────────────────────────────────────────────────
    console.log(`\n📤 Submitting inventory (${totalAdded} items)...`);
    await page.screenshot({ path: "/tmp/10-before-submit.png" });

    const submitBtn = page.locator('button:has-text("SUBMIT"), button:has-text("Submit")').first();
    await submitBtn.waitFor({ timeout: 10000 });
    await submitBtn.click();
    await delay(2000);

    // Confirm dialog if appears
    const confirmBtn = page.locator('button:has-text("CONFIRM"), button:has-text("Confirm"), button:has-text("YES"), button:has-text("Yes"), button:has-text("OK")').first();
    if (await confirmBtn.count() > 0) {
      await confirmBtn.click();
      await delay(1000);
      console.log("✅ Confirmed submit dialog");
    }

    await page.screenshot({ path: "/tmp/11-submitted.png" });
    console.log(`\n🎉 SUCCESS! ${totalAdded} items added to ${reservationId}`);

    return { success: true, itemsAdded: totalAdded, reservation: reservationId };

  } catch (err) {
    console.error("❌ AUTOMATION ERROR:", err.message);
    console.error(err.stack);
    try { await page.screenshot({ path: "/tmp/error-final.png" }); } catch {}
    throw err;
  } finally {
    await browser.close();
    console.log("🔒 Browser closed");
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Elromco Inventory Bot v2" });
});

app.post("/fill-inventory", async (req, res) => {
  const { reservation_id, categories } = req.body;
  if (!reservation_id) return res.status(400).json({ error: "reservation_id required" });
  if (!categories?.length) return res.status(400).json({ error: "categories required" });

  const totalItems = categories.reduce((a, c) => a + (c.items?.length || 0), 0);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🚀 NEW REQUEST: ${reservation_id} | ${categories.length} rooms | ${totalItems} items`);
  console.log(`${"=".repeat(50)}`);

  try {
    const result = await fillInventory(reservation_id, categories);
    console.log("✅ Request completed successfully");
    res.json(result);
  } catch (err) {
    console.error("❌ Request failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🤖 Elromco Bot running on port ${PORT}`);
  console.log(`📡 POST /fill-inventory to start automation`);
});
