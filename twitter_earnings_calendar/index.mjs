import "dotenv/config";
import fs from "fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import { fetchFirstEarningsImage } from "../x.com/fetchImage.mjs";

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
  await client.login(DISCORD_TOKEN);
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);

  const users = X_USERNAMES.split(/\r?\n/).map(u => u.trim()).filter(Boolean);

  for (const username of users) {
    const stateFile = `./twitter_earning_calendar/last_link_${username}.json`;
    const sent = await loadSent(stateFile);

    const today = new Date();
    const day = today.getDay();
    const diff = day === 0 ? 6 : day - 1; // ISO-week: Monday=1…Sunday=0→treat Sunday as last
    const monday = new Date(today);
    monday.setDate(today.getDate() - diff);
    
    const monthNames = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    const formatted = `${monthNames[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
    const searchTerm = `from:${username} "#earnings for the week of ${formatted}"`;
    
    const imageUrl = await fetchFirstEarningsImage(searchTerm);
    console.log(`Fetched link for ${username}:`, imageUrl);

    const newLinks = [imageUrl].filter(l => !sent.includes(l));
    if (!newLinks.length) continue;

    // send the new link to Discord
    await channel.send(link);

    // sleep a bit to avoid being rate-limited
    await sleep(1000);

    // save the growing array of all sent links
    await saveSent(stateFile, sent.concat(newLinks));
  }

  await client.destroy();
}

run().catch(console.error);
