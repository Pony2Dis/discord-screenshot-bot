import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5) {
  const browser = await firefox.launch();
  const page = await browser.newPage();
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });

  // grab all unique status URLs
  const all = await page.$$eval(
    'article a[href*="/status/"]',
    els => Array.from(new Set(els.map(a => a.href)))
  );

  // keep only pure "/status/{id}" URLs
  const pure = all.filter(link =>
    /^https:\/\/x\.com\/[^\/]+\/status\/\d+$/.test(link)
  );

  await browser.close();
  return pure.slice(0, limit);
}
