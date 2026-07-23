import fs from "node:fs";
import { chromium } from "playwright";

const OUT = "/tmp/umans-gate-mobile-test";
const URL = "http://localhost:1945/dashboard/";

const report = { test1: {}, test2: {}, test3: {}, test4: {}, test5: {} };

function log(section, key, value) {
  if (!report[section]) report[section] = {};
  report[section][key] = value;
  console.log(`[${section}] ${key}:`, value);
}

async function closeDrawer(page) {
  const overlay = page.locator('[data-slot="sheet-overlay"]');
  if (await overlay.count()) {
    try {
      await overlay.click({ force: true, timeout: 2000 });
    } catch {}
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

async function openDrawer(page) {
  await page.locator('button[aria-label="Open captures"]').click({ force: true });
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector('button[aria-label="Open captures"]', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Seed if needed via API
  const apiResp = await fetch("http://localhost:1945/dashboard/api/captures?limit=5")
    .then((r) => r.json())
    .catch(() => null);
  const haveData = apiResp && Array.isArray(apiResp.captures) && apiResp.captures.length > 0;
  console.log("Have data:", haveData, "sample:", JSON.stringify(apiResp)?.slice(0, 120));

  if (!haveData) {
    console.log("Seeding 25 captures via HTTP through proxy...");
    for (let i = 0; i < 25; i++) {
      try {
        await fetch("http://localhost:1945/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "test-seed" },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 10,
            messages: [{ role: "user", content: `seed ${i}` }],
          }),
        });
      } catch (_e) {}
    }
    console.log("Seeding done.");
    await page.waitForTimeout(1500);
  }

  // ========== TEST 1: Mobile scroll ==========
  await openDrawer(page);
  await page.screenshot({ path: `${OUT}/v3-01-drawer-open.png`, fullPage: false });

  const scrollData = await page.evaluate(() => {
    const viewports = Array.from(document.querySelectorAll('[data-slot="scroll-area-viewport"]'));
    const visible = viewports.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const vp = visible[0] || viewports[0];
    if (!vp) return { error: "no viewport", count: viewports.length };
    const rect = vp.getBoundingClientRect();
    const sb = document.querySelector('[data-slot="scroll-area-scrollbar"]');
    const thumb = document.querySelector('[data-slot="scroll-area-thumb"]');
    const sbRect = sb ? sb.getBoundingClientRect() : null;
    const thumbRect = thumb ? thumb.getBoundingClientRect() : null;
    return {
      scrollHeight: vp.scrollHeight,
      clientHeight: vp.clientHeight,
      scrollRange: vp.scrollHeight - vp.clientHeight,
      scrollTopBefore: vp.scrollTop,
      scrollbarWidth: sbRect ? sbRect.width : null,
      scrollbarComputedWidth: sb ? getComputedStyle(sb).width : null,
      thumbWidth: thumbRect ? thumbRect.width : null,
      thumbBg: thumb ? getComputedStyle(thumb).backgroundColor : null,
      viewportCount: viewports.length,
      visibleCount: visible.length,
      vpRect: { w: rect.width, h: rect.height },
    };
  });
  console.log("Scroll data:", JSON.stringify(scrollData, null, 2));
  Object.assign(report.test1, scrollData);

  // Programmatically scroll
  await page.evaluate(() => {
    const viewports = Array.from(document.querySelectorAll('[data-slot="scroll-area-viewport"]'));
    const visible = viewports.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const vp = visible[0] || viewports[0];
    if (vp) vp.scrollTo({ top: 400, behavior: "instant" });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/v3-02-after-scroll.png`, fullPage: false });

  const scrollTopAfter = await page.evaluate(() => {
    const viewports = Array.from(document.querySelectorAll('[data-slot="scroll-area-viewport"]'));
    const visible = viewports.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const vp = visible[0] || viewports[0];
    return vp ? vp.scrollTop : null;
  });
  log("test1", "scrollTopAfter", scrollTopAfter);

  // ========== TEST 2: Mobile tabs ==========
  await closeDrawer(page);
  await page.screenshot({ path: `${OUT}/v3-03-tabs-initial.png`, fullPage: false });

  const tabData = await page.evaluate(() => {
    const ts = document.querySelector(".tab-scroll");
    if (!ts) return { error: "no .tab-scroll" };
    const cs = getComputedStyle(ts);
    return {
      overflowX: cs.overflowX,
      maskImage: cs.maskImage || cs.webkitMaskImage,
      scrollWidth: ts.scrollWidth,
      clientWidth: ts.clientWidth,
    };
  });
  console.log("Tab data:", JSON.stringify(tabData));
  Object.assign(report.test2, tabData);

  await page.evaluate(() => {
    const ts = document.querySelector(".tab-scroll");
    if (ts) ts.scrollTo({ left: ts.scrollWidth, behavior: "instant" });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/v3-04-tabs-scrolled.png`, fullPage: false });

  const configTab = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const config = tabs.find((t) => /config/i.test(t.textContent || ""));
    if (!config) return { found: false };
    const r = config.getBoundingClientRect();
    return {
      found: true,
      left: r.left,
      right: r.right,
      width: r.width,
      visible: r.left >= 0 && r.right <= 390,
    };
  });
  console.log("Config tab:", JSON.stringify(configTab));
  Object.assign(report.test2, { configTab });

  // ========== TEST 3: Sheet width ==========
  await openDrawer(page);
  await page.screenshot({ path: `${OUT}/v3-05-sheet-width.png`, fullPage: false });

  const sheetData = await page.evaluate(() => {
    const sheet = document.querySelector('[data-slot="sheet-content"]');
    if (!sheet) return { error: "no sheet-content" };
    const r = sheet.getBoundingClientRect();
    return { width: r.width, height: r.height, left: r.left };
  });
  console.log("Sheet data:", JSON.stringify(sheetData));
  Object.assign(report.test3, sheetData);

  // ========== TEST 4: Empty-state overlay ==========
  const overlayData = await page.evaluate(() => {
    const sheet = document.querySelector('[data-slot="sheet-content"]');
    const aside = document.querySelector(
      '[data-slot="sheet-content"] aside, [data-slot="sheet-content"] > aside, aside',
    );
    const sheetBg = sheet ? getComputedStyle(sheet).backgroundColor : null;
    const asideBg = aside ? getComputedStyle(aside).backgroundColor : null;
    const sheetStyle = sheet ? getComputedStyle(sheet) : null;

    const emptyText = document.body.innerText.includes("Select a capture to inspect");
    const emptyEls = Array.from(document.querySelectorAll("*")).filter((el) => {
      const t = el.textContent || "";
      return t.includes("Select a capture") && el.children.length === 0;
    });
    let emptyOutsideDrawer = false;
    let emptyRect = null;
    let emptyParentChain = null;
    if (emptyEls.length > 0 && sheet) {
      const r = emptyEls[0].getBoundingClientRect();
      emptyRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const sr = sheet.getBoundingClientRect();
      emptyOutsideDrawer = !(
        r.left >= sr.left &&
        r.right <= sr.right &&
        r.top >= sr.top &&
        r.bottom <= sr.bottom
      );
      let node = emptyEls[0];
      let insideSheet = false;
      while (node) {
        if (node === sheet) {
          insideSheet = true;
          break;
        }
        node = node.parentElement;
      }
      emptyParentChain = insideSheet ? "inside-sheet" : "outside-sheet";
    }

    return {
      sheetBg,
      asideBg,
      sheetOpacity: sheetStyle ? sheetStyle.opacity : null,
      sheetBgImage: sheetStyle ? sheetStyle.backgroundImage : null,
      emptyTextPresent: emptyText,
      emptyOutsideDrawer,
      emptyParentChain,
      emptyRect,
    };
  });
  console.log("Overlay data:", JSON.stringify(overlayData, null, 2));
  Object.assign(report.test4, overlayData);

  await page.screenshot({ path: `${OUT}/v3-06-no-bleed.png`, fullPage: false });

  // ========== TEST 5: Desktop sanity ==========
  await closeDrawer(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/v3-07-desktop.png`, fullPage: false });

  const desktopData = await page.evaluate(() => {
    const hamburger = document.querySelector('button[aria-label="Open captures"]');
    const hamburgerVisible = hamburger ? hamburger.getBoundingClientRect().width > 0 : false;
    const tabsList = document.querySelector('[role="tablist"]');
    let tabsOverflow = false;
    let tabCount = 0;
    if (tabsList) {
      tabCount = tabsList.querySelectorAll('[role="tab"]').length;
      tabsOverflow = tabsList.scrollWidth > tabsList.clientWidth + 1;
    }
    return { hamburgerVisible, sidebarVisible: !hamburgerVisible, tabCount, tabsOverflow };
  });
  console.log("Desktop data:", JSON.stringify(desktopData));
  Object.assign(report.test5, desktopData);

  await context.close();
} catch (e) {
  console.error("ERROR:", e);
  report.error = String(e);
} finally {
  await browser.close();
}

fs.writeFileSync(`${OUT}/results-v3.json`, JSON.stringify(report, null, 2));
console.log("\n=== FULL REPORT ===");
console.log(JSON.stringify(report, null, 2));
console.log("DONE");
