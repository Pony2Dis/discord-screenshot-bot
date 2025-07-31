// twitter/fetchLatestPosts.mjs
import "dotenv/config";
import { firefox } from "playwright";

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const { X_EMAIL, X_PASSWORD } = process.env;
  if (!X_EMAIL || !X_PASSWORD) {
    throw new Error("Please set X_EMAIL and X_PASSWORD in your .env");
  }

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ————————————————————————————————————————————————
  // 1) LOGIN
  await page.goto("https://x.com/login", { waitUntil: "networkidle" });

  // fill email/username and hit Next
  await page.fill('input[name="text"]', X_EMAIL);
  await page.click('button:has-text("Next")');

  // race between password field or a second username prompt
  await Promise.race([
    page.waitForSelector('input[name="password"]', { timeout: 5000 }),
    page.waitForSelector('input[name="text"]',     { timeout: 5000 }),
  ]);

  // handle “enter phone or username” screen if it appears
  if (await page.$('input[name="text"]')) {
    // refill the same email/username
    await page.fill('input[name="text"]', X_EMAIL);
    await page.click('button:has-text("Next")');
    // now wait for password field
    await page.waitForSelector('input[name="password"]', { timeout: 5000 });
  }

  // tiny pause to mimic human pacing
  await page.waitForTimeout(500);

  // fill password and submit
  await page.fill('input[name="password"]', X_PASSWORD);
  await page.click('button:has-text("Log in")');

  // wait until we see the Profile link in the top bar
  await page.waitForSelector("a[aria-label='Profile']", { timeout: 30000 });

  // ————————————————————————————————————————————————
  // 2) NAVIGATE TO THE USER’S PROFILE
  await page.goto(`https://x.com/${username}`, { waitUntil: "networkidle" });

  // cutoff for how far back we’ll go
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  let links = [];

  // 3) SCROLL & EXTRACT LOOP
  for (let i = 0; i < 10 && links.length < limit; i++) {
    const newOnPage = await page.$$eval(
      'a[href*="/status/"]',
      (els, username) =>
        Array.from(els, a => a.getAttribute("href"))
          .filter(h => new RegExp(`^/${username}/status/\\d+$`).test(h)),
      username
    );

    console.log("found:", newOnPage);

    for (let path of newOnPage) {
      if (seen.has(path)) continue;
      const ts = await page
        .$eval(`a[href="${path}"] time`, el => el.dateTime)
        .catch(() => null);
      if (!ts || new Date(ts).getTime() < cutoff) continue;
      seen.add(path);
      links.push(`https://x.com${path}`);
      if (links.length >= limit) break;
    }

    // scroll and wait
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(2000);
  }

  await browser.close();
  return links.slice(0, limit);
}
