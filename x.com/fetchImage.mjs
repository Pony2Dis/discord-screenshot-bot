// fetchImage.mjs
import { firefox } from "playwright";
import fs from "fs/promises";
import path from "path";

export async function fetchFirstEarningsImage(fromUser, formatted) {
  let browser;
  let imgUrl = null;
  let result = null;

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

    console.log("Launching Firefox browser...");
    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("https://x.com", { timeout: 60000 });

    console.log("searching for:", formatted, "from:", fromUser);
    const searchTerm = `from:${fromUser} "${formatted}"`;
    console.log("Waiting for the search box to appear...");
    await page.waitForSelector('input[data-testid="SearchBox_Search_Input"]', { timeout: 60000 });
    await page.click('input[data-testid="SearchBox_Search_Input"]');
    await page.fill('input[data-testid="SearchBox_Search_Input"]', searchTerm);
    await page.keyboard.press("Enter");

    console.log("Waiting for search results to load...");
    await page.waitForSelector("article", { timeout: 60000 });

    // get the article post link
    console.log("Fetching posts from search results...");
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
      console.error("❌ No posts found in search results");
      throw new Error("No posts found in search results");
    }

    // loop through the items to find the first one that contains the exact search term in the text
    const firstItem = items.find(item => item.text.includes(formatted));
    if (!firstItem) {
      console.error("❌ No matching post found for the search term");

      console.log("post text:", items.map(item => item.text).join("\n"));

      throw new Error("No matching post found for the search term");
    }
    console.log("First matching post found:", firstItem.url);

    // navigate to the first post
    console.log("Navigating to the first post URL:", firstItem.url);
    await page.goto(firstItem.url, { timeout: 60000 });

    // wait for the post image to load
    console.log("Waiting for the image to load in the post...");
    await page.waitForSelector(
      'xpath=/html/body/div[1]/div/div/div[2]/main/div/div/div/div[1]/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[2]/div/div/div/div/div[1]/div/div/a/div/div[2]/div/img',
      { timeout: 60000 }
    );

    // get the image URL from the first result
    const imgHandle = await page.$(
      'xpath=/html/body/div[1]/div/div/div[2]/main/div/div/div/div[1]/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[2]/div/div/div/div/div[1]/div/div/a/div/div[2]/div/img'
    );

    if (!imgHandle) {
      console.error("❌ No image found in first result");
      throw new Error("No image found in first result");
    }

    console.log("Image found, extracting URL...");
    imgUrl = await imgHandle.getAttribute("src");

    // strip “&name=small” if present
    if (imgUrl.includes("&name=small")) {
        imgUrl = imgUrl.replace(/&name=small/g, "");
    }

    console.log("Image URL found:", imgUrl);
    result = {postUrl: firstItem.url, imageUrl: imgUrl};
  } catch (err) {
    console.error("❌ Error fetching image:", err);
    // wait 4 minutes before closing the browser to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 240000));
  } finally {
    if (browser) await browser.close();
  }

  return result;
}

// // Example usage:
// (async () => {
//   const term = "#earnings for the week of August 4, 2025";
//   const username = "eWhispers";
//   const result = await fetchFirstEarningsImage(username, term);
//   console.log("Found image URL:", result.imageUrl);
//   console.log("Post URL:", result.postUrl);
// })();
