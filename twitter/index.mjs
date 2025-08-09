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

async function main() {
  try {
    await client.login(DISCORD_TOKEN);
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);

    const users = X_USERNAMES.split(/\r?\n/).map(u => u.trim()).filter(Boolean);

    for (const username of users) {
      try {
        const stateFile = `./twitter/last_link_${username}.json`;
        const sent = await loadSent(stateFile);
        const links = await fetchLatestPosts(username, 10);
        console.log(`Fetched links for ${username}:`, links);
            
        let newLinks = links.filter(l => !sent.includes(l));
        if (!newLinks.length) continue;

        // ewmove duplicates from newLinks
        newLinks = new Set(newLinks);
        newLinks = Array.from(newLinks);

        for (let link of newLinks.reverse()) {
          await channel.send(link);

          // sleep a bit to avoid being rate-limited
          await sleep(1000);
        }
        // save the growing array of all sent links
        await saveSent(stateFile, sent.concat(newLinks));
      }
      catch (error) {
        console.error(`Error processing user ${username}:`, error);
      }
    }
  }
  catch (error) {
    console.error("Error in main execution:", error);
  }
  finally {
    console.log("Finished processing all users.");
    if(client) await client.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  client?.destroy().then(() => process.exit(1));
});
