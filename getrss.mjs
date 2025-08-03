import "dotenv/config";
import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID;
const EMBED_HOSTS = (process.env.EMBED_HOSTS || "")
  .split(/\r?\n/)
  .map(h => h.trim())
  .filter(Boolean);
const STATE_FILE = path.resolve("./rss-state.json");
const sleep = ms => new Promise(res => setTimeout(res, ms));
const SLEEP_BETWEEN_SENDS = 3000;

async function loadState() {
  try {
    return JSON.parse(await fs.promises.readFile(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  console.log(`Saving state to ${STATE_FILE}…`);
  const t0 = Date.now();
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`State saved in ${Date.now() - t0} ms`);
}

async function main() {
  const parser = new Parser({ requestOptions: { timeout: 10000 } });
  const state = await loadState();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(NEWS_CHANNEL_ID);

  // last‑17h cutoff
  const now = new Date();
  const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const FEEDS = (process.env.RSS_FEEDS || "")
    .split(/[\r\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);

  const allNew = [];

  for (const url of FEEDS) {
    console.log(`Fetching: ${url}`);
    let feed;
    try {
      feed = await parser.parseURL(url);
    } catch (err) {
      console.error(`⚠️ Skipping ${url}: ${err.message}`);
      continue;
    }
    const seen = new Set(state[url] || []);
    for (const item of feed.items) {
      const uniqueId = item.link;
      if (!seen.has(uniqueId) && new Date(item.pubDate) >= cutoff) {
        console.log(`  ✔ Queued (17h): ${item.title}`);
        allNew.push({ item });
        seen.add(uniqueId);
      }
    }
    state[url] = Array.from(seen);
  }

  console.log(`\nTotal new items to post: ${allNew.length}`);
  console.log(`Sorting and posting…`);
  const sorted = allNew.sort(
    (a, b) => new Date(a.item.pubDate) - new Date(b.item.pubDate)
  );

  for (const { item } of sorted) {
    console.log(`Posting now: ${item.title} (${item.pubDate})`);

    // get the hostname from the link
    const { hostname } = new URL(item.link);

    if (EMBED_HOSTS.some(domain => hostname.includes(domain))) {
      const embed = new EmbedBuilder()
        .setURL(item.link)
        .setTimestamp(new Date(item.pubDate || Date.now()));

      if (item.title) {
        embed.setTitle(item.title);
      }
      
      const snippet = item.contentSnippet?.slice(0, 200);
      if (snippet) embed.setDescription(snippet);

      // If the RSS gives an image…
      if (item.enclosure?.url) embed.setImage(item.enclosure.url);

      await channel.send({
        embeds: [embed],
      });
    } else {
      // include the link in `content` so Discord will unfurl it
      await channel.send({
        content: `[לינק לכתבה](${item.link})`,
      });
    }

    // wait a bit to avoid hitting Discord rate limits
    await sleep(SLEEP_BETWEEN_SENDS);

  }

  await saveState(state);
  console.log(`\n✅ All done! destroying client…`);
  client.destroy();
  console.log(`✅ Client destroyed, exiting…`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
