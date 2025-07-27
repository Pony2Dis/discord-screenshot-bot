// getrss.mjs
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Parser from 'rss-parser';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const NEWS_CHANNEL_ID = process.env.NEWS_CHANNEL_ID;
const STATE_FILE      = path.resolve('./rss-state.json');

async function loadState() {
  try { return JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf-8')); }
  catch { return {}; }
}

async function saveState(state) {
  console.log(`Saving state to ${STATE_FILE}…`);
  const t0 = Date.now();
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`State saved in ${Date.now() - t0} ms`);
}

async function main() {
  const parser = new Parser({ requestOptions: { timeout: 10000 } });
  const state  = await loadState();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(NEWS_CHANNEL_ID);

  const FEEDS = (process.env.RSS_FEEDS || '')
    .split(/[\r\n,]+/).map(u => u.trim()).filter(Boolean);

  const allNew = [];
  const now = new Date();

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
      const id = item.guid || item.link;
      if (!seen.has(id)) {
        const d = new Date(item.pubDate);
        if (
          d.getFullYear() === now.getFullYear() &&
          d.getMonth()    === now.getMonth() &&
          d.getDate()     === now.getDate()
        ) {
          console.log(`  ✔ Queued for today: ${item.title}`);
          allNew.push({ item });
        } else {
          console.log(`  ✖ Ignored (not today): ${item.title}`);
        }
        seen.add(id);
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
    const embed = new EmbedBuilder()
      .setTitle(item.title)
      .setURL(item.link)
      .setTimestamp(new Date(item.pubDate));
    const snippet = item.contentSnippet?.slice(0, 200);
    if (snippet) embed.setDescription(snippet);
    await channel.send({ embeds: [embed] });
  }

  await saveState(state);
  client.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
