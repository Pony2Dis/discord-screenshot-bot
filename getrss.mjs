import 'dotenv/config';
import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;
const NEWS_CHANNEL_ID  = process.env.NEWS_CHANNEL_ID;
const STATE_FILE       = path.resolve("./rss-state.json");

console.log('token length:', DISCORD_TOKEN?.length);
console.log('channel id :', NEWS_CHANNEL_ID);

// 1. List your RSS feeds here
const FEEDS = [
  "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069",
  "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147",
  "https://www.prnewswire.com/rss/energy-latest-news/energy-latest-news-list.rss",
];

async function loadState() {
  try {
    return JSON.parse(await fs.promises.readFile(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  const parser = new Parser();
  const state  = await loadState();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(NEWS_CHANNEL_ID);

  for (const url of FEEDS) {
    const feed = await parser.parseURL(url);
    const seen = new Set(state[url] || []);
    const newItems = [];

    for (const item of feed.items) {
      const id = item.guid || item.link;
      if (!seen.has(id)) {
        newItems.push({ id, item });
        seen.add(id);
      }
    }

    newItems.sort((a, b) =>
      new Date(a.item.pubDate) - new Date(b.item.pubDate)
    );

    for (const { item } of newItems) {
        const embed = new EmbedBuilder()
          .setTitle(item.title)
          .setURL(item.link)
          .setTimestamp(new Date(item.pubDate));
  
        // only add a description if there's actual text
        const snippet = item.contentSnippet?.slice(0, 200);
        if (snippet) {
          embed.setDescription(snippet);
        }
  
        await channel.send({ embeds: [embed] });
    }
  
    state[url] = Array.from(seen);
  }

  await saveState(state);
  client.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
