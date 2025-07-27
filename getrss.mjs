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
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  const parser = new Parser({ requestOptions: { timeout: 10000 } });
  const state  = await loadState();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(NEWS_CHANNEL_ID);

  const cutoff = Date.now() - 17 * 60 * 60 * 1000;
  const FEEDS = (process.env.RSS_FEEDS || '').split(/[\r\n,]+/).filter(Boolean);
  const allNew = [];

  for (const url of FEEDS) {
    let feed;
    try { feed = await parser.parseURL(url); }
    catch { continue; }

    const seen = new Set(state[url] || []);
    for (const item of feed.items) {
      const id = item.guid || item.link;
      if (!seen.has(id) && new Date(item.pubDate).getTime() >= cutoff) {
        allNew.push({ item });
        seen.add(id);
      }
    }
    state[url] = Array.from(seen);
  }

  allNew
    .sort((a,b) => new Date(a.item.pubDate) - new Date(b.item.pubDate))
    .forEach(async ({ item }) => {
      const embed = new EmbedBuilder()
        .setTitle(item.title || '')
        .setURL(item.link)
        .setTimestamp(new Date(item.pubDate || Date.now()));

      if (item.contentSnippet) 
        embed.setDescription(item.contentSnippet.slice(0, 200));

      // **NEW**: If the RSS gives an image…
      if (item.enclosure?.url) 
        embed.setImage(item.enclosure.url);

      // **NEW**: include the link in `content` so Discord will unfurl it
      await channel.send({
        content: `[לינק לכתבה](${item.link})`,
        embeds: [embed]
      });
    });

  await saveState(state);
  client.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
