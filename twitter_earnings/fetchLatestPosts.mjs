// twitter/fetchLatestPosts.mjs
import "dotenv/config";
import { firefox } from "playwright";

export async function fetchLatestPosts(
  username,
  limit = 5,
  days = 7
) {
  const { X_EMAIL, X_PASSWORD, X_USERNAME } = process.env;
  if (!X_EMAIL || !X_PASSWORD || !X_USERNAME) {
    throw new Error(
      "Please set X_EMAIL, X_PASSWORD and X_USERNAME in your .env"
    );
  }

  // 1) spin up browser
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ————————————————————————————————————————————————
  // 2) LOGIN FLOW
  await page.goto("https://x.com/login", { waitUntil: "networkidle" });

  // enter your email
  await page.fill('input[name="text"]', X_EMAIL);
  await page.click('button:has-text("Next")');

  // wait up to 15s for either password field or the extra username prompt
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    // if password input appears, break out
    if (await page.$('input[name="password"]')) {
      break;
    }

    // if they’re asking again for text (phone/username), fill X_USERNAME
    const extra = await page.$(
      'input[name="text"][data-testid="ocfEnterTextTextInput"]'
    );
    if (extra) {
      await page.fill('input[name="text"]', X_USERNAME);
      await page.click('button:has-text("Next")');
    }

    await page.waitForTimeout(500);
  }

  // now password step
  await page.fill('input[name="password"]', X_PASSWORD);
  await page.click('button:has-text("Log in")');
  await page.waitForSelector("a[aria-label='Profile']", {
    timeout: 30_000,
  });

  // ————————————————————————————————————————————————
  // 3) GO TO TARGET PROFILE
  await page.goto(`https://x.com/${username}`, {
    waitUntil: "networkidle",
  });

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const links = [];

  // 4) SCROLL & EXTRACT
  for (let i = 0; i < 10 && links.length < limit; i++) {
    const paths = await page.$$eval(
      'a[href*="/status/"]',
      (els, user) =>
        Array.from(els, (a) => a.getAttribute("href"))
          .filter((h) => new RegExp(`^/${user}/status/\\d+$`).test(h)),
      username
    );
    console.log("found:", paths);

    for (const path of paths) {
      if (seen.has(path)) continue;
      const ts = await page
        .$eval(`a[href="${path}"] time`, (t) => t.dateTime)
        .catch(() => null);
      if (!ts || new Date(ts).getTime() < cutoff) continue;

      seen.add(path);
      links.push(`https://x.com${path}`);
      if (links.length >= limit) break;
    }

    // scroll down & wait
    await page.evaluate(() =>
      window.scrollBy(0, window.innerHeight)
    );
    await page.waitForTimeout(2000);
  }

  await browser.close();
  return links;
}
