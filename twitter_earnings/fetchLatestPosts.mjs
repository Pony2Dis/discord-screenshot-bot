// twitter/fetchLatestPosts.mjs
import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  // 1) Go to profile
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  let links = [];

  // 2) Scroll & extract loop
  const maxScrolls = 10;
  let lastCount = 0;

  for (let i = 0; i < maxScrolls && links.length < limit; i++) {
    // extract all status links in the viewport
    const newOnPage = await page.$$eval(
      'article[data-testid="tweet"] a[href*="/status/"]',
      (as, username) => {
        return as
          .map(a => a.getAttribute('href'))
          .filter(h => {
            // exactly /{user}/status/{id}, no extra path
            const m = h.match(new RegExp(`^/${username}/status/\\d+$`));
            return m;
          });
      },
      username
    );

    // dedupe + filter by age
    for (let path of newOnPage) {
      if (seen.has(path)) continue;
      // grab timestamp for that tweet
      const timeSel = `a[href="${path}"] time`;
      const ts = await page.$eval(timeSel, t => t.dateTime).catch(() => null);
      if (!ts || new Date(ts).getTime() < cutoff) continue;

      seen.add(path);
      links.push(`https://x.com${path}`);
      if (links.length >= limit) break;
    }

    if (links.length === lastCount) {
      // nothing new this scroll → give up
      break;
    }
    lastCount = links.length;

    // scroll and wait for new tweets to load
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(2000);
  }

  await browser.close();
  return links.slice(0, limit);
}
