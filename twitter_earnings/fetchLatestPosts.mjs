import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  // collect tweet objects from GraphQL responses
  const tweets = [];
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/i/api/graphql/') && url.includes('UserTweets')) {
      try {
        const body = await res.json();
        const entries = body.data?.user?.result?.timeline?.timeline?.instructions
          .flatMap(inst => inst.entries || [])
          .filter(e => e.content?.itemContent?.tweet_results)
          .map(e => e.content.itemContent.tweet_results.result);
        tweets.push(...entries);
      } catch {}
    }
  });

  // go to profile and scroll a few times
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  await browser.close();

  // now filter and build URLs
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  const urls = tweets
    .filter(t => {
      const dt = new Date(t.legacy.created_at).getTime();
      return dt >= cutoff && /^\d+$/.test(t.rest_id);
    })
    .map(t => {
      const url = `https://x.com/${username}/status/${t.rest_id}`;
      if (seen.has(url)) return null;
      seen.add(url);
      return url;
    })
    .filter(Boolean);

  return urls.slice(0, limit);
}
