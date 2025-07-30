// twitter/fetchLatestPosts.mjs
import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

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

  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });
  // scroll so those GraphQL calls fire
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }
  await browser.close();

  // now filter by age & dedupe
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
