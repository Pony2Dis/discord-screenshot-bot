import { chromium } from 'playwright';

export async function fetchLatestPosts(username, limit = 5) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });
  const links = await page.$$eval('article a[href*="/status/"]', els =>
    Array.from(new Set(els.map(a => a.href))).slice(0, limit)
  );
  await browser.close();
  return links;
}
