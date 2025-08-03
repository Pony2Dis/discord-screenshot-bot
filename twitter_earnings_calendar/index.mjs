// twitter_earnings_calendar/index.mjs

import "dotenv/config";
import fs from "fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import {
  fetchFirstEarningsImage,
  closeBrowser
} from "../x.com/fetchImage.mjs";

const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, X_USERNAMES } = process.env;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sleep = ms => new Promise(res => setTimeout(res, ms));

const monthNames = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

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
      const stateFile = `./twitter_earnings_calendar/last_link_${username}.json`;
      const sent = await loadSent(stateFile);

      // compute this week’s Monday
      const today = new Date();
      const day   = today.getDay();
      const diff  = day - 1;
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - diff);

      // previous, current, next
      for (const offset of [-1, 0, 1]) {
        const monday = new Date(thisMonday);
        monday.setDate(thisMonday.getDate() + offset * 7);
        let formatted = `${monthNames[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
        formatted = `#earnings for the week of ${formatted}`;
        const tag = offset < 0 ? "previous" : offset > 0 ? "next" : "current";

        try {
          const { imageUrl, postUrl } = await fetchFirstEarningsImage(username, formatted);
          if (!postUrl || sent.includes(postUrl)) {
            continue;
          }

          console.log(`Fetched ${tag}-week link for ${username}:`, imageUrl, "at post:", postUrl);
          await channel.send(imageUrl);
          await sleep(1000);
          sent.push(postUrl);
        } catch (err) {
          console.error(`❌ Error fetching ${tag}-week image for ${username}:`, err);
          // back off 4 minutes if something goes wrong
          await sleep(240000);
        }
      }

      await saveSent(stateFile, sent);
    }

    // close the shared browser once all users are done
    await closeBrowser();
  } catch (err) {
    console.error("Error in main execution:", err);
  } finally {
    console.log("Finished processing all users.");
    if (client) await client.destroy();
  }
}

run().catch(console.error);
