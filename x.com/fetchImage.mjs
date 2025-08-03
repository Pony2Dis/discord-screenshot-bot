// fetchImage.mjs
import { firefox } from "playwright";
import fs from "fs/promises";
import path from "path";

let browser, context, page;

async function initBrowser() {
  if (page) return;
  console.log("Reading cookies from cookies.txt...");
  const cookiesPath = path.resolve(process.cwd(), "x.com", "cookies.txt");
  const cookieHeader = await fs.readFile(cookiesPath, "utf-8");
  if (!cookieHeader) {
    console.error("❌ cookies.txt is empty or not found");
    throw new Error("No cookies found in cookies.txt");
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

    console.log("Waiting for the search box to appear...");
    await page.waitForSelector('input[data-testid="SearchBox_Search_Input"]', { timeout: 60000 });
    await page.click('input[data-testid="SearchBox_Search_Input"]');
    await page.fill('input[data-testid="SearchBox_Search_Input"]', searchTerm);
    await page.keyboard.press("Enter");

    console.log("Waiting for search results to load...");
    await page.waitForSelector("article", { timeout: 60000 });

    console.log("Fetching posts from search results...");
    const items = await page.$$eval("article", articles =>
      articles.map(a => {
        const link = a.querySelector('a[href*="/status/"]')?.href;
        const date = a.querySelector("time")?.getAttribute("datetime");
        const text = a.querySelector("div[lang]")?.textContent?.trim();
        return link && date ? { url: link, date, text } : null;
      }).filter(Boolean)
    );

    if (!items.length) {
      console.error("❌ No posts found in search results");
      throw new Error("No posts found");
    }

    const firstItem = items.find(item => item.text.includes(formatted));
    if (!firstItem) {
      console.error("❌ No matching post found for the search term");
      console.log("post text:", items.map(i => i.text).join("\n"));
      throw new Error("No matching post");
    }
    console.log("First matching post found:", firstItem.url);

    console.log("Navigating to the first post URL:", firstItem.url);
    await page.goto(firstItem.url, { timeout: 60000 });

    console.log("Waiting for the image to load in the post...");
    await page.waitForSelector(
      'xpath=/html/body/div[1]/div/div/div[2]/main/div/div/div/div[1]/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[2]/div/div/div/div/div[1]/div/div/a/div/div[2]/div/img',
      { timeout: 60000 }
    );

    console.log("Image found, extracting URL...");
    const imgHandle = await page.$(
      'xpath=/html/body/div[1]/div/div/div[2]/main/div/div/div/div[1]/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[2]/div/div/div/div/div[1]/div/div/a/div/div[2]/div/img'
    );
    if (!imgHandle) {
      console.error("❌ No image found in first result");
      throw new Error("No image");
    }

    let imgUrl = await imgHandle.getAttribute("src");
    if (imgUrl.includes("&name=small")) {
      imgUrl = imgUrl.replace(/&name=small/g, "");
    }
    console.log("Image URL found:", imgUrl);

    result = { postUrl: firstItem.url, imageUrl: imgUrl };
  } catch (err) {
    console.error("❌ Error fetching image:", err);
    // back off 4 minutes on failure
    await new Promise(r => setTimeout(r, 240000));
  }

  return result;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = context = page = null;
  }
}
