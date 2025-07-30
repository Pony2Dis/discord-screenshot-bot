// twitter/fetchLatestPosts.mjs
import { firefox } from 'playwright';

export async function fetchLatestPosts(username, limit = 5, days = 7) {
  const browser = await firefox.launch();
  const page = await browser.newPage();

  // 1) Visit profile to get cookies/guest token
  await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle' });

  // 2) Read numeric userId out of Next-data
  const profileJson = await page.evaluate(() =>
    JSON.parse(document.querySelector('script[id="__NEXT_DATA__"]')?.textContent || '{}')
  );
  const userObj = profileJson.props?.pageProps?.user || {};
  const userId = userObj.legacy?.rest_id || userObj.rest_id;
  if (!userId) throw new Error('Could not extract userId');

  // 3) Prepare GraphQL call details
  const queryId = '0uQE4rvNofAr4pboHOZWVA';  // X.com’s UserTweets op
  const baseVars = {
    userId,
    count: 20,
    includePromotedContent: true,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true
  };

  // Helper: runs the GraphQL call inside the page context so cookies flow
  const fetchPage = async ({ queryId, vars }) => {
    const url =
      `https://x.com/i/api/graphql/${queryId}/UserTweets?` +
      `variables=${encodeURIComponent(JSON.stringify(vars))}` +
      `&features=${encodeURIComponent('{}')}`;
    const res = await fetch(url, { credentials: 'include' });
    return res.json();
  };

  // 4) Pull pages until we have enough
  let cursor = null;
  let collected = [];
  do {
    const vars = cursor
      ? { ...baseVars, cursor: { value: cursor } }
      : { ...baseVars };
    const resp = await page.evaluate(fetchPage, { queryId, vars });

    const instr = resp.data?.user?.result?.timeline?.timeline?.instructions || [];
    // extract tweets
    for (let inst of instr) {
      for (let e of inst.entries || []) {
        const tweet = e.content?.itemContent?.tweet_results?.result;
        if (tweet) collected.push(tweet);
      }
    }
    // extract bottom cursor for next page
    cursor =
      instr
        .flatMap(i => i.entries || [])
        .find(e => e.content?.cursorType === 'Bottom')
        ?.content.value || null;

  } while (cursor && collected.length < limit * 2);  // collect a bit extra

  await browser.close();

  // 5) Filter by age, dedupe, build URLs, and limit
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const seen = new Set();
  const urls = [];
  for (let t of collected) {
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
