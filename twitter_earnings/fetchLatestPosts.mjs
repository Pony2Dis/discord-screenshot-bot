// twitter/fetchLatestPosts.mjs
import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  // Intercept the guest token and CSRF token from the page
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });
  const guestToken = await page.evaluate(() =>
    window.__INITIAL_STATE__?.guestToken ||
      document.cookie.match(/ct0=([^;]+)/)?.[1]
  );
  const crumb = await page.evaluate(() =>
    document.cookie.match(/ct0=([^;]+)/)?.[1]
  );

  // Build the GraphQL URL exactly as your HAR shows it:
  const queryId = '0uQE4rvNofAr4pboHOZWVA';  // the UserTweets operation you saw
  const vars = {
    userId: null,
    count: 20,
    includePromotedContent: true,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true
  };

  // We need the numeric userId for that handle:
  const profileJson = await page.evaluate(() =>
    JSON.parse(
      document.querySelector('script[id="__NEXT_DATA__"]')?.textContent || '{}'
    )
  );
  // navigate the Next.js data to find the userId
  const userObj = profileJson.props?.pageProps?.user;
  vars.userId = userObj?.legacy?.rest_id || userObj?.rest_id;

  // Fetch the GraphQL timeline JSON inside the browser (so cookies + tokens flow automatically)
  const resp = await page.evaluate(
    async (queryId, vars) => {
      const url =
        `https://x.com/i/api/graphql/${queryId}/UserTweets?` +
        `variables=${encodeURIComponent(JSON.stringify(vars))}` +
        `&features=${encodeURIComponent('{}')}`;
      const r = await fetch(url, { credentials: 'include' });
      return r.json();
    },
    queryId,
    vars
  );
  await browser.close();

  // Pull out the tweets, filter by age & dedupe
  const cutoff = Date.now() - days * 24 * 3600 * 1e3;
  const seen = new Set();
  const urls = [];

  const instructions =
    resp.data?.user?.result?.timeline?.timeline?.instructions || [];

  for (let inst of instructions) {
    for (let entry of inst.entries || []) {
      const tr = entry.content?.itemContent?.tweet_results?.result;
      if (!tr) continue;
      const t = tr.legacy;
      const tdate = new Date(t.created_at).getTime();
      if (tdate < cutoff) continue;
      const link = `https://x.com/${username}/status/${tr.rest_id}`;
      if (!seen.has(link)) {
        seen.add(link);
        urls.push(link);
        if (urls.length === limit) break;
      }
    }
    if (urls.length === limit) break;
  }

  return urls;
}
