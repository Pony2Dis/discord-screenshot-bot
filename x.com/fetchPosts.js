import { firefox } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";

async function fetchLatestPosts(username, limit = 10, days = 7) {
    // create results array for the returned urls, and init with empty array
    var results = [];
    var browser;
  
    try {
      console.log("Reading cookies from cookies.txt...");
      const cookiesPath = path.resolve(process.cwd(), "x.com", "cookies.txt");
      const cookieHeader = await fs.readFile(cookiesPath, "utf-8");
      if (!cookieHeader) {
        console.error("❌ cookies.txt is empty or not found");
        process.exit(1);
      }
  
      console.log("Parsing cookies...");
      const cookies = cookieHeader.split("; ").map((cookie) => {
        const [name, value] = cookie.split("=");
        return {
          name,
          value,
          domain: ".x.com",
          path: "/",
          secure: true,
        };
      });
      console.log(
        "Cookies parsed:",
        JSON.stringify(cookies.slice(0, 2), null, 2)
      );
  
      console.log("Launching Firefox browser (non-headless)...");
      browser = await firefox.launch({ headless: false });
      const context = await browser.newContext();
      await context.addCookies(cookies);
      const page = await context.newPage();
  
      console.log(`Navigating to https://x.com/${username}...`);
      try {
        await page.goto(`https://x.com/${username}`, { timeout: 60000 });
        console.log(
          "Initial navigation completed, waiting 15 seconds for page to load..."
        );
        await page.waitForTimeout(15000); // Increased to 15 seconds
        console.log("Checking for profile content...");
        await page.waitForSelector("article", { timeout: 60000 }); // Wait for articles to appear
        console.log("Profile page loaded with content");
      } catch (navError) {
        console.error("Navigation failed:", navError.message);
        await page.screenshot({ path: "error-screenshot.png" });
        console.log("Saved screenshot to error-screenshot.png");
        await fs.writeFile("error-page.html", await page.content());
        console.log("Saved page HTML to error-page.html");
        await browser.close();
        process.exit(1);
      }
  
      console.log("Scrolling to load more posts...");
      for (let i = 0; i < (limit * 1.5); i++) {
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
              return link && date ? { url: link, date, text } : null;
            })
            .filter(Boolean)
        );
  
        // check if items is empty
        if (items.length === 0) {
          console.log("No posts found in this scroll");
          continue;
        }
        console.log(`Found ${items.length} posts in this scroll`);
  
        // filter out duplicates based on URL
        const uniqueItems = items.filter(
          (item) => !results.some((r) => r.url === item.url)
        );
        if (uniqueItems.length === 0) {
          console.log("No new unique posts found in this scroll");
          continue;
        }
        console.log(`Adding ${uniqueItems.length} unique posts to results`);
  
        // append unique items to results
        results.push(...uniqueItems);
      }
  
      // check if results is empty
      if (results.length === 0) {
        console.log(`No posts found for ${username}`);
        return [];
      }

      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      const recent = results.filter((i) => new Date(i.date).getTime() >= cutoff);

      // check if recent is empty
      if (recent.length === 0) {
        console.log(`No posts found for ${username} in the last ${days} days`);
        return [];
      }

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
      process.exit(1);
    }
    finally {
      console.log("Closing browser...");
      await browser.close();
    }
  
    return results;
  }

// Example usage
// const results = await fetchLatestPosts("TheTranscript", 5).catch(console.error);
// console.log("Fetched posts:", results.join("\n"));
