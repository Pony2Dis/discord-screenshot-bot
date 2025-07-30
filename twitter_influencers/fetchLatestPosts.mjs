import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5) {
  const browser = await firefox.launch();
  const page = await browser.newPage();
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });

  // extract each article’s URL + timestamp
  const items = await page.$$eval('article', articles =>
    articles.map(a => {
      const link = a.querySelector('a[href*="/status/"]')?.href;
      const date = a.querySelector('time')?.getAttribute('datetime');
      return link && date ? { url: link, date } : null;
    }).filter(Boolean)
  );

  await browser.close();

  // only keep posts ≤7 days old
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = items
    .filter(i => new Date(i.date).getTime() >= cutoff)
    .map(i => i.url);

  // dedupe & only exact "/status/{id}" URLs, then limit
  const unique = Array.from(new Set(recent))
    .filter(u => /^https:\/\/x\.com\/[^\/]+\/status\/\d+$/.test(u));

  return unique.slice(0, limit);
}
