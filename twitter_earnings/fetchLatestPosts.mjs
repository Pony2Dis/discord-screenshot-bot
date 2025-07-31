// twitter/fetchLatestPosts.mjs
import "dotenv/config";
import { firefox } from "playwright";

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const { X_EMAIL, X_PASSWORD } = process.env;
  if (!X_EMAIL || !X_PASSWORD) {
    throw new Error("Please set X_EMAIL and X_PASSWORD in your .env");
  }

  const VIEWPORT = { width: 1920, height: 1080 };
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  // await page.setViewportSize(VIEWPORT);

  // ————————————————————————————————————————————————
  // 1) LOGIN
  await page.goto("https://x.com/login", { waitUntil: "networkidle" });

  // fill email/username
  await page.fill('input[name="text"]', X_EMAIL);
  await page.click('button:has-text("Next")');
  // wait for password input to appear
  await page.waitForSelector('input[name="password"]', { timeout: 5000 });

  // sleep a bit to avoid being rate-limited
  await page.waitForTimeout(1000);

  // fill password
  await page.fill('input[name="password"]', X_PASSWORD);
  await page.click('button:has-text("Log in")');

  // wait for your home feed to load (detect by profile link showing up)
  await page.waitForSelector("a[aria-label='Profile']", { timeout: 10000 });

  // ————————————————————————————————————————————————
  // 2) NAVIGATE TO THE USER’S PROFILE
  await page.goto(`https://x.com/${username}`, {
    waitUntil: "networkidle",
  });

  // collect only “/user/status/####” URLs newer than cutoff
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  let links = [];

  // 3) SCROLL & EXTRACT LOOP
  for (let i = 0; i < 10 && links.length < limit; i++) {
    // grab all pure-status paths in the viewport
    const newOnPage = await page.$$eval(
      'a[href*="/status/"]',
      (els, username) =>
        Array.from(els, a => a.getAttribute("href"))
          .filter(h =>
            new RegExp(`^/${username}/status/\\d+$`).test(h)
          ),
      username
    );

    console.log("found:", newOnPage);

    // filter out duplicates and too-old
    for (let path of newOnPage) {
      if (seen.has(path)) continue;
      // timestamp is in the <time> nested under that link
      const ts = await page
        .$eval(`a[href="${path}"] time`, el => el.dateTime)
        .catch(() => null);
      if (!ts || new Date(ts).getTime() < cutoff) continue;

      seen.add(path);
      links.push(`https://x.com${path}`);
      if (links.length >= limit) break;
    }

    // scroll down and wait for new items to load
    await page.evaluate(() =>
      window.scrollBy(0, window.innerHeight)
    );
    await page.waitForTimeout(2000);
  }

  await browser.close();
  return links.slice(0, limit);
}
