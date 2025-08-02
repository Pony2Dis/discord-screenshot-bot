import { firefox } from "playwright";
import fs from "fs/promises";
import path from "path";

export async function fetchLatestPosts(username, limit = 10, days = 7) {
  let results = [];
  let browser;
  let noNewCount = 0;

  try {
    const cookiesPath = path.resolve(process.cwd(), "x.com", "cookies.txt");
    const cookieHeader = await fs.readFile(cookiesPath, "utf-8");
    if (!cookieHeader) throw new Error("cookies.txt empty");
    const cookies = cookieHeader.split("; ").map(c => {
      const [name, value] = c.split("=");
      return { name, value, domain: ".x.com", path: "/", secure: true };
    });

    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(`https://x.com/${username}`, { timeout: 60000 });
    await page.waitForSelector("article", { timeout: 60000 });

    for (let i = 0; i < limit * 1.5; i++) {
      await page.evaluate(() => window.scrollBy(0, 700));
      await page.waitForTimeout(1000);

      const items = await page.$$eval("article", articles =>
        articles
          .map(a => {
            const link = a.querySelector('a[href*="/status/"]')?.href;
            const date = a.querySelector("time")?.getAttribute("datetime");
            return link && date ? { url: link, date } : null;
          })
          .filter(Boolean)
      );

      const uniqueItems = items.filter(
        item => !results.some(r => r.url === item.url)
      );

      if (uniqueItems.length === 0) {
        noNewCount++;
        console.log(`No new unique posts (${noNewCount}/5)`);
        if (noNewCount >= 5) {
          console.log("No new posts for 5 consecutive scrolls—stopping early");
          break;
        }
        continue;
      } else {
        noNewCount = 0;
      }

      results.push(...uniqueItems);
    }

    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const recent = results.filter(i => new Date(i.date).getTime() >= cutoff);
    const regex = new RegExp(`^https://x\\.com/${username}/status/\\d+$`);

    results = Array.from(new Set(recent.map(i => i.url)))
      .filter(u => regex.test(u))
      .slice(0, limit);

    if (results.length === 0) return [];

    console.log(`Latest ${results.length} posts from ${username}:`);
  } catch (err) {
    console.error("❌ Error fetching posts:", err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }

  return results;
}

// Example usage
// const results = await fetchLatestPosts("TheTranscript", 5).catch(console.error);
// console.log("Fetched posts:", results.join("\n"));