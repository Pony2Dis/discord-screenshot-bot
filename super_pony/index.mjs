import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import axios from "axios";

const { DISCORD_TOKEN, FINNHUB_TOKEN, BOT_CHANNEL_ID } = process.env;

const timeMap = {
  amc: "After Market Close",
  bmo: "Before Market Open",
  dmh: "During Market Hours",
  "": "Unknown Time",
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

client.on("messageCreate", async (message) => {
  if (message.channel.id !== BOT_CHANNEL_ID || message.author.bot) return;

  if (message.content.toLowerCase().startsWith("/todays earnings")) {
    await message.channel.send("🔄 שולף את הטיקרים של המדווחות להיום...");
    console.log(`Fetching today's earnings for channel: ${message.channel.id}`);

    try {
      const today = new Date().toISOString().split("T")[0];
      const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`;
      console.log(`Fetching from URL: ${url}`);
      const resp = await axios.get(url);
      if (resp.status !== 200) {
        throw new Error(`Unexpected status code: ${resp.status}`);
      }

      console.log(`Response data: ${JSON.stringify(resp.data).substring(0, 300)}`);
      let items = resp.data.earningsCalendar || resp.data;

      // parse optional "limit: N" parameter
      const limitMatch = message.content.match(/limit:\s*(\d+)/i);
      if (limitMatch) {
        const l = parseInt(limitMatch[1], 10);
        console.log(`Applying limit: ${l}`);
        items = items.slice(0, l);
      }

      if (!items.length) {
        console.log("No earnings found for today.");
        return message.channel.send("לא מצאתי דיווח רווחים להיום.");
      }

      // group tickers by report time
      const groups = items.reduce((acc, e) => {
        const label = timeMap[e.hour] || e.hour;
        acc[label] = acc[label] || [];
        acc[label].push(`${e.symbol}`);
        return acc;
      }, {});

      // order sections
      const order = [
        "Before Market Open",
        "During Market Hours",
        "After Market Close",
        "Unknown Time"
      ];

      // send grouped sections
      console.log(`returning grouped sections: ${JSON.stringify(groups).substring(0, 300)}`);
      const maxLen = 1900;
      for (const label of order) {
        const syms = groups[label];
        if (!syms) continue;

        let chunk = `==============\n**${label}:**\n==============\n`;
        for (const sym of syms) {
          const addition = `${sym}, `;
          if ((chunk + addition).length > maxLen) {
            await message.channel.send(chunk.trim().replace(/, $/, ""));
            chunk = ""; // continuation: only tickers
          }
          chunk += addition;
        }
        await message.channel.send(chunk.trim().replace(/, $/, ""));
      }
    } catch (err) {
      console.error(err);
      await message.channel.send("❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים.");
    }
  }
});

client.login(DISCORD_TOKEN);
