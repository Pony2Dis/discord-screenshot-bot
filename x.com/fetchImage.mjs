// fetchImage.mjs
import { firefox } from "playwright";
import fs from "fs/promises";
import path from "path";

export async function fetchFirstEarningsImage(searchTerm) {
  let browser;
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

    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("https://x.com", { timeout: 60000 });

    await page.waitForSelector('input[data-testid="SearchBox_Search_Input"]', { timeout: 60000 });
    await page.click('input[data-testid="SearchBox_Search_Input"]');
    await page.fill('input[data-testid="SearchBox_Search_Input"]', searchTerm);
    await page.keyboard.press("Enter");

    await page.waitForSelector("article", { timeout: 60000 });
    const imgHandle = await page.$(
      'xpath=/html/body/div[1]/div/div/div[2]/main/div/div/div/div[1]/div/div[3]/section/div/div/div[1]/div/div/article/div/div/div[2]/div[2]/div[3]/div/div/div/div[1]/div/div/a/div/div[2]/div/img'
    );

    if (!imgHandle) {
      console.error("❌ No image found in first result");
      throw new Error("No image found in first result");
    }

    let imgUrl = await imgHandle.getAttribute("src");
    // strip “&name=small” if present
    if (imgUrl.includes("&name=small")) {
        imgUrl = imgUrl.replace(/&name=small/g, "");
    }
    console.log("Image URL found:", imgUrl);
  } catch (err) {
    console.error("❌ Error fetching image:", err);
  } finally {
    if (browser) await browser.close();
  }

  return imgUrl;
}

// Example usage:
// (async () => {
//   const term = 'from:eWhispers "#earnings for the week of August 4, 2025"';
//   const imageUrl = await fetchFirstEarningsImage(term);
//   console.log("Found image URL:", imageUrl);
// })();
