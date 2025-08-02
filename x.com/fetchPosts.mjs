import { firefox } from "playwright";
import fs from "fs/promises";
import path from "path";

export async function fetchLatestPosts(username, limit = 10, days = 7) {
  // create results array for the returned urls, and init with empty array
  let results = [];
  let browser;
  let noNewCount = 0;

  try {
    console.log("Reading cookies from cookies.txt...");
    const cookiesPath = path.resolve(process.cwd(), "x.com", "cookies.txt");
    const cookieHeader = await fs.readFile(cookiesPath, "utf-8");
    if (!cookieHeader) {
      console.error("❌ cookies.txt is empty or not found");
      throw new Error("No cookies found in cookies.txt");
    }
    console.log("Parsing cookies...");
    const cookies = cookieHeader.split("; ").map((cookie) => {
      const [name, value] = cookie.split("=");
      return { name, value, domain: ".x.com", path: "/", secure: true };
    });
    console.log(
      "Cookies parsed:",
      JSON.stringify(cookies.slice(0, 2), null, 2)
    );

    console.log("Launching Firefox browser (headless)...");
    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();

    console.log(`Navigating to https://x.com/${username}...`);
    await page.goto(`https://x.com/${username}`, { timeout: 60000 });
    console.log("Initial navigation completed, waiting 15 seconds for page to load...");
    await page.waitForTimeout(15000);
    console.log("Checking for profile content...");
    await page.waitForSelector("article", { timeout: 60000 });
    console.log("Profile page loaded with content");

    console.log("Scrolling to load more posts...");
    for (let i = 0; i < limit * 1.5; i++) {
      await page.evaluate(() => window.scrollBy(0, 700));
      await page.waitForTimeout(1000);
      console.log(`Scroll ${i + 1} completed`);
      console.log("Extracting post URLs and timestamps...");

      const items = await page.$$eval("article", (articles) =>
        articles
          .map((a) => {
            const link = a.querySelector('a[href*="/status/"]')?.href;
            const date = a.querySelector("time")?.getAttribute("datetime");
            const text = a.querySelector("div[lang]")?.textContent?.trim();
            return link && date
              ? { url: link, date, text }
              : null;
          })
          .filter(Boolean)
      );

      if (items.length === 0) {
        console.log("No posts found in this scroll");
        continue;
      }
      console.log(`Found ${items.length} posts in this scroll`);

      const uniqueItems = items.filter(
        (item) => !results.some((r) => r.url === item.url)
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
      console.log(`Adding ${uniqueItems.length} unique posts to results`);
      results.push(...uniqueItems);
    }

    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const recent = results.filter((i) => new Date(i.date).getTime() >= cutoff);
    const regex = new RegExp(`^https://x\\.com/${username}/status/\\d+$`);
    results = Array.from(new Set(recent.map((i) => i.url)))
      .filter((u) => regex.test(u))
      .slice(0, limit);

    if (results.length === 0) {
      console.log(`No posts found for ${username}`);
      return [];
    }
    console.log(`Latest ${results.length} posts from ${username}:`);
  } catch (error) {
    console.error("❌ Error fetching posts:");
    console.error(error.message);
  } finally {
    console.log("Closing browser...");
    if (browser) await browser.close();
  }

  return results;
}

// Example usage:
// (async () => {
//   const posts = await fetchLatestPosts("TheTranscript", 5);
//   console.log("Fetched posts:", posts);
// })();
