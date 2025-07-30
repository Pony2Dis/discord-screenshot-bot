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

  // filter out any ".../status/ID/analytics" links
  const filtered = all.filter(link => !/\/analytics$/.test(link));

  await browser.close();
  return filtered.slice(0, limit);
}
