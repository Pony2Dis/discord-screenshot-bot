// Full updated index.mjs

import "dotenv/config";
import fs from "fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import { fetchLatestPosts } from "../x.com/fetchPosts.mjs";

const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, X_USERNAMES } = process.env;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sleep = ms => new Promise(res => setTimeout(res, ms));

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
  try {
    await client.login(DISCORD_TOKEN);
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);

    const users = X_USERNAMES
      .split(/\r?\n/)
      .map(u => u.trim())
      .filter(Boolean);

    for (const username of users) {
      try {
        const stateFile = `./twitter_influencers/last_link_${username}.json`;
        const sent = await loadSent(stateFile);
        const links = await fetchLatestPosts(username, 10);
        console.log(`Fetched links for ${username}:`, links);

        // --- URL normalization to avoid duplicates ---
        const normalizeUrl = url => {
          try {
            const u = new URL(url);
            return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
          } catch {
            return url.replace(/\?.*$/, '').replace(/\/$/, '');
          }
        };
        const normalizedSent = sent.map(normalizeUrl);
        const newLinks = links.filter(link => !normalizedSent.includes(normalizeUrl(link)));
        if (!newLinks.length) continue;

        for (let link of newLinks.reverse()) {
          await channel.send(link);
          await sleep(1000);
        }

        // Save only the clean URLs
        const updatedSent = Array.from(
          new Set([
            ...normalizedSent,
            ...newLinks.map(normalizeUrl)
          ])
        );
        await saveSent(stateFile, updatedSent);
      } catch (error) {
        console.error(`Error processing user ${username}:`, error);
      }
    }
  } catch (error) {
    console.error("Error in main execution:", error);
  } finally {
    console.log("Finished processing all users.");
    if (client) await client.destroy();
  }
}

run().catch(console.error);
