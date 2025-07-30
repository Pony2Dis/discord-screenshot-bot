import "dotenv/config";
import fs from "fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import { fetchLatestPosts } from "./fetchLatestPosts.mjs";

const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, X_USERNAMES } = process.env;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function loadSent(file) {
  try {
    const txt = await fs.readFile(file, "utf-8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function saveSent(file, sent) {
  await fs.writeFile(file, JSON.stringify(sent, null, 2), "utf-8");
}

async function run() {
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);

  const users = X_USERNAMES.split(/\r?\n/).map(u => u.trim()).filter(Boolean);

  for (const username of users) {
    const stateFile = `./twitter/last_link_${username}.json`;
    const sent = await loadSent(stateFile);
    const links = await fetchLatestPosts(username, 10);
    console.log(`Fetched links for ${username}:`, links);
        
    const newLinks = links.filter(l => !sent.includes(l));
    if (!newLinks.length) continue;

    for (let link of newLinks.reverse()) {
      await channel.send(link);
    }
    // save the growing array of all sent links
    await saveSent(stateFile, sent.concat(newLinks));
  }

  await client.destroy();
}

run().catch(console.error);
