import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  // 1) Prime the page to set cookies/guest token
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });

  // 2) Extract numeric userId from Next.js data
  const profileJson = await page.evaluate(() =>
    JSON.parse(document.querySelector('script[id="__NEXT_DATA__"]')?.textContent || '{}')
  );
  const userObj = profileJson.props?.pageProps?.user;
  const userId = userObj?.legacy?.rest_id || userObj?.rest_id;

  // 3) Call the same GraphQL endpoint your HAR shows, passing both args as one object
  const queryId = '0uQE4rvNofAr4pboHOZWVA';
  const vars = {
    userId,
    count: 20,
    includePromotedContent: true,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true
  };
  const resp = await page.evaluate(
    async ({ queryId, vars }) => {
      const url =
        `https://x.com/i/api/graphql/${queryId}/UserTweets?` +
        `variables=${encodeURIComponent(JSON.stringify(vars))}` +
        `&features=${encodeURIComponent('{}')}`;
      const r = await fetch(url, { credentials: 'include' });
      return r.json();
    },
    { queryId, vars }
  );

  await browser.close();

  // 4) Filter, dedupe & limit
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  const urls = [];
  const instructions = resp.data?.user?.result?.timeline?.timeline?.instructions || [];

  for (let inst of instructions) {
    for (let entry of inst.entries || []) {
      const tr = entry.content?.itemContent?.tweet_results?.result;
      if (!tr) continue;
      const tdate = new Date(tr.legacy.created_at).getTime();
      if (tdate < cutoff) continue;
      const link = `https://x.com/${username}/status/${tr.rest_id}`;
      if (!seen.has(link)) {
        seen.add(link);
        urls.push(link);
        if (urls.length >= limit) break;
      }
    }
    if (urls.length >= limit) break;
  }

  return urls;
}
