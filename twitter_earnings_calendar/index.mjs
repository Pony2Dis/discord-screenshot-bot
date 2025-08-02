import "dotenv/config";
import fs from "fs/promises";
import { Client, GatewayIntentBits } from "discord.js";
import { fetchFirstEarningsImage } from "../x.com/fetchImage.mjs";

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

    const users = X_USERNAMES.split(/\r?\n/).map(u => u.trim()).filter(Boolean);

    for (const username of users) {
      const stateFile = `./twitter_earnings_calendar/last_link_${username}.json`;
      const sent = await loadSent(stateFile);


      // compute this week’s Monday
      const today = new Date();
      const day = today.getDay();
      const diff = day - 1;
      const thisMonday = new Date(today);
      let newLinks = [];
      thisMonday.setDate(today.getDate() - diff);
      
      // loop over previous, current and next week
      for (const offset of [-1, 0, 1]) {
        const monday = new Date(thisMonday);
        monday.setDate(thisMonday.getDate() + offset * 7);
        const formatted = `${monthNames[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
        const tag = offset < 0 ? 'previous' : offset > 0 ? 'next' : 'current';
        const searchTerm = `from:${username} "#earnings for the week of ${formatted}"`;
        
        const imageUrl = await fetchFirstEarningsImage(searchTerm);
        console.log(`Fetched ${tag}-week link for ${username}:`, imageUrl);

        newLinks = [imageUrl].filter(l => !sent.includes(l));
        if (!newLinks.length) continue;

        // send the new link to Discord
        await channel.send(newLinks[0]);

        // sleep a bit to avoid being rate-limited
        await sleep(1000);

        // add the new link to the sent array
        sent.push(newLinks[0]);
      }

      // save the growing array of all sent links
      await saveSent(stateFile, sent.concat(newLinks));
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

run().catch(console.error);
