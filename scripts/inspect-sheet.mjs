import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
await page.goto("http://localhost:1945/dashboard/", { waitUntil: "networkidle" });
await page.waitForSelector('button[aria-label="Open captures"]', { timeout: 15000 });
await page.waitForTimeout(500);
await page.locator('button[aria-label="Open captures"]').click({ force: true });
await page.waitForTimeout(1500);

const data = await page.evaluate(() => {
  // Find the sheet and all descendants
  const sheet = document.querySelector('[data-slot="sheet-content"]');
  if (!sheet) return { error: "no sheet-content" };
  const sheetRect = sheet.getBoundingClientRect();

  // Check ALL CSS vars and their resolved values on the sheet
  const sheetCs = getComputedStyle(sheet);
  const sheetClasses = sheet.className;

  // Find the aside and main inner element
  const aside = sheet.querySelector("aside");
  const asideCs = aside ? getComputedStyle(aside) : null;
  const asideClasses = aside ? aside.className : null;

  // Check the bg-popover class - what does it resolve to?
  // Look at root :root vars
  const root = document.documentElement;
  const rootCs = getComputedStyle(root);
  const vars = {};
  for (const v of ["--popover", "--background", "--card", "--muted", "--border"]) {
    vars[v] = rootCs.getPropertyValue(v);
  }

  // Check if Tailwind utility bg-popover is present
  const hasBgPopover =
    sheetClasses.includes("bg-popover") ||
    (aside && asideCs && asideCs.className && asideCs.className.includes("bg-popover"));
  const asideHasBgPopover = aside ? aside.className.includes("bg-popover") : false;
  const sheetHasBgPopover = sheetClasses.includes("bg-popover");

  // Check what bg-* classes are on sheet and aside
  const sheetBgClasses = sheetClasses.match(/bg-\S+/g) || [];
  const asideBgClasses = aside ? aside.className.match(/bg-\S+/g) || [] : [];

  // Check sheet-content data-slot and its computed background more carefully
  // Look for any child with a background color set
  const descendants = Array.from(sheet.querySelectorAll("*"));
  const opaqueEls = [];
  for (const el of descendants.slice(0, 50)) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
      const r = el.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) {
        opaqueEls.push({
          tag: el.tagName,
          slot: el.getAttribute("data-slot"),
          className: el.className.slice(0, 120),
          bg,
          w: r.width,
          h: r.height,
        });
      }
    }
  }

  return {
    sheetRect: {
      w: sheetRect.width,
      h: sheetRect.height,
      left: sheetRect.left,
      top: sheetRect.top,
    },
    sheetClasses: sheetClasses.slice(0, 300),
    sheetBg: sheetCs.backgroundColor,
    sheetBgImage: sheetCs.backgroundImage,
    sheetOpacity: sheetCs.opacity,
    sheetHasBgPopover,
    sheetBgClasses,
    asideClasses: asideClasses ? asideClasses.slice(0, 300) : null,
    asideBg: asideCs ? asideCs.backgroundColor : null,
    asideHasBgPopover,
    asideBgClasses,
    vars,
    opaqueEls: opaqueEls.slice(0, 10),
  };
});

console.log(JSON.stringify(data, null, 2));
await page.screenshot({
  path: "/tmp/umans-gate-mobile-test/v3-inspect-sheet.png",
  fullPage: false,
});
await browser.close();
