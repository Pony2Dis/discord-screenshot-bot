import "dotenv/config";
import fs from "fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import { fetchLatestPosts } from "./fetchLatestPosts.mjs";

const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, X_USERNAMES } = process.env;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function loadLast(file) {
  try { return (await fs.readFile(file, "utf-8")).trim(); }
  catch { return null; }
}

async function saveLast(file, link) {
  await fs.writeFile(file, link, "utf-8");
}

async function run() {
  const channel = await (await client.login(DISCORD_TOKEN))
    .channels.fetch(DISCORD_CHANNEL_ID);

  const users = X_USERNAMES
    .split(/\r?\n/)
    .map(u => u.trim())
    .filter(Boolean);

  for (const username of users) {
    const stateFile = `./twitter/last_link_${username}.txt`;
    const last = await loadLast(stateFile);
    const links = await fetchLatestPosts(username, 10);
    const newLinks = last ? links.filter(l => l !== last) : links;
    if (newLinks.length === 0) continue;

    for (let link of newLinks.reverse()) {
      await channel.send(link);
    }
    await saveLast(stateFile, newLinks[0]);
  }

  await client.destroy();
}

run().catch(console.error);
