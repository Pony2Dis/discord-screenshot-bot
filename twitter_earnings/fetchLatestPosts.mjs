import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  // 1) Intercept all UserTweets GraphQL responses
  const tweets = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/i/api/graphql/') && url.includes('UserTweets')) {
      try {
        const json = await res.json();
        const inst = json.data?.user?.result?.timeline?.timeline?.instructions || [];
        for (let entry of inst.flatMap(i => i.entries || [])) {
          const t = entry.content?.itemContent?.tweet_results?.result;
          if (t) tweets.push(t);
        }
      } catch {}
    }
  });

  // 2) Go to the profile and scroll until we have enough
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });
  let previousCount = 0;
  for (let i = 0; i < 10 && tweets.length < limit * 2; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    // stop early if no new tweets arrived in this scroll
    if (tweets.length === previousCount) break;
    previousCount = tweets.length;
  }

  await browser.close();

  // 3) Filter by age, dedupe, build URLs, and limit
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  const urls = [];
  for (let t of tweets) {
    const tdate = new Date(t.legacy.created_at).getTime();
    if (tdate < cutoff) continue;
    const link = `https://x.com/${username}/status/${t.rest_id}`;
    if (!seen.has(link)) {
      seen.add(link);
      urls.push(link);
      if (urls.length >= limit) break;
    }
  }

  return urls;
}
