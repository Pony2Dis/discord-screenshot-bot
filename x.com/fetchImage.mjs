import { firefox } from "playwright";

let browser, context, page;

async function initBrowser() {
  if (page) return;

  console.log("Reading cookies from env var COOKIE_HEADER...");
  const cookieHeader = process.env.X_COOKIE_HEADER;
  if (!cookieHeader) {
    console.error("❌ COOKIE_HEADER env var is not set");
    throw new Error("No cookies provided in COOKIE_HEADER");
  }

  console.log("Parsing cookies...");
  const cookies = cookieHeader.split("; ").map(cookie => {
    const [name, value] = cookie.split("=");
    return { name, value, domain: ".x.com", path: "/", secure: true };
  });
  console.log("Cookies parsed:", JSON.stringify(cookies.slice(0,2), null,2));

  console.log("Launching Firefox browser...");
  browser = await firefox.launch({ headless: true });
  context = await browser.newContext();
  await context.addCookies(cookies);
  page = await context.newPage();
  await page.goto("https://x.com", { timeout: 60000 });
}

export async function fetchFirstEarningsImage(fromUser, formatted) {
  let result = null;
  try {
    await initBrowser();

    console.log("searching for:", formatted, "from:", fromUser);
    const searchTerm = `from:${fromUser} "${formatted}"`;

    await page.waitForSelector('input[data-testid="SearchBox_Search_Input"]', { timeout: 60000 });
    await page.click('input[data-testid="SearchBox_Search_Input"]');
    await page.fill('input[data-testid="SearchBox_Search_Input"]', searchTerm);
    await page.keyboard.press("Enter");

    await page.waitForSelector("article", { timeout: 60000 });

    const items = await page.$$eval("article", articles =>
      articles.map(a => {
        const link = a.querySelector('a[href*="/status/"]')?.href;
        const date = a.querySelector("time")?.getAttribute("datetime");
        const text = a.querySelector("div[lang]")?.textContent?.trim() || "";
        return link && date ? { url: link, date, text } : null;
      }).filter(Boolean)
    );
    if (!items.length) throw new Error("No posts found");

    const firstItem = items.find(item => item.text.includes(formatted));
    if (!firstItem) throw new Error("No matching post");

    await page.goto(firstItem.url, { timeout: 60000 });

    await page.waitForSelector('img[src*="twimg.com/media"]', { timeout: 60000 });
    const imgUrl = await page.$eval('img[src*="twimg.com/media"]', img => {
      let src = img.getAttribute("src") || "";
      return src.replace(/&name=small/g, "");
    });

    result = { postUrl: firstItem.url, imageUrl: imgUrl };
  } catch (err) {
    console.error("❌ Error fetching image:", err);
    throw err;
  }
  return result;
}

// NEW: from prepared search URL (Latest tab). Returns first result with media.
export async function fetchLatestImpliedMoveCard(searchUrl) {
  await initBrowser();

  console.log("Navigating to prepared search URL…");
  await page.goto(searchUrl, { timeout: 60000 });

  // Ensure results loaded
  await page.waitForSelector("article", { timeout: 60000 });

  // Pick the first article that contains a media image
  const item = await page.$$eval("article", arts => {
    for (const a of arts) {
      const link = a.querySelector('a[href*="/status/"]')?.href;
      const img  = a.querySelector('img[src*="twimg.com/media"]');
      if (link && img) {
        let src = img.getAttribute("src") || "";
        src = src.replace(/&name=small/g, "");
        return { postUrl: link, imageUrl: src };
      }
    }
    return null;
  });

  if (!item) throw new Error("No image result found in search");
  console.log("Found implied-move:", item.postUrl);
  return item;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = context = page = null;
  }
}
