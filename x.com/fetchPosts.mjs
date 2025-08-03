// Full updated x.com/fetchPosts.mjs

import { firefox } from "playwright";

export async function fetchLatestPosts(username, limit = 10, days = 7) {
  let results = [];
  let noNewCount = 0;
  const seenUrls = new Set();

  let browser;
  try {
    console.log("Reading cookies from env var X_COOKIE_HEADER...");
    const cookieHeader = process.env.X_COOKIE_HEADER;
    if (!cookieHeader) throw new Error("No cookies provided");
    const cookies = cookieHeader.split("; ").map(cookie => {
      const [name, value] = cookie.split("=");
      return { name, value, domain: ".x.com", path: "/", secure: true };
    });

    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    console.log(`Fetching page link: https://x.com/${username}`);
    await page.goto(`https://x.com/${username}`, { timeout: 60000 });
    console.log("Waiting for page to load...");
    await page.waitForTimeout(15000);
    console.log("waiting for article elements to appear...");
    try {
      await page.waitForSelector("article", { timeout: 30000 });
    } catch (error) {
      console.error("❌ Error waiting for articles:", error);
      // save the current page html for debugging
      const pageContent = await page.content();
      const fs = require("fs");
      fs.writeFileSync(`./debug_${username}.html`, pageContent);
      console.log(`Saved current page content to debug_${username}.html`);
      throw new Error("Failed to load articles on the page");
    }

    for (let i = 0; i < limit * 1.5; i++) {
      await page.evaluate(() => window.scrollBy(0, 700));
      await page.waitForTimeout(1000);

      const itemsRaw = await page.$$eval("article", articles =>
        articles
          .map(a => {
            const link = a.querySelector('a[href*="/status/"]')?.href;
            const date = a.querySelector("time")?.getAttribute("datetime");
            const text = a.querySelector("div[lang]")?.textContent?.trim();
            return link && date ? { url: link, date, text } : null;
          })
          .filter(Boolean)
      );

      console.log(`Found ${itemsRaw.length} posts in this scroll`);

      const newItems = [];
      for (const item of itemsRaw) {
        // check if there is a url in seenUrls that is part of the sring: item.url
        if (!Array.from(seenUrls).some(url => item.url.includes(url))) {
          seenUrls.add(item.url);
          newItems.push(item);
        }
      }

      if (newItems.length === 0) {
        noNewCount++;
        console.log(`No new unique posts (${noNewCount}/5)`);
        if (noNewCount >= 5) break;
      } else {
        noNewCount = 0;
        console.log(`Adding ${newItems.length} unique posts`);
        results.push(...newItems);
      }
    }

    // filter by date & format URLs
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const recent = results.filter(i => new Date(i.date).getTime() >= cutoff);
    const regex = new RegExp(`^https://x\\.com/${username}/status/\\d+$`);
    const finalUrls = Array.from(new Set(recent.map(i => i.url)))
      .filter(u => regex.test(u))
      .slice(0, limit);

    if (!finalUrls.length) {
      console.log(`No posts found for ${username}`);
      return [];
    }
    return finalUrls;
  } catch (error) {
    console.error("❌ Error fetching posts:", error);
    return [];
  } finally {
    if (browser) {
      console.log("Closing browser...");
      await browser.close();
    }
  }
}
