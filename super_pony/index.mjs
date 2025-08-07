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
      const items = resp.data.earningsCalendar || resp.data;
      if (!items.length) {
        console.log("No earnings found for today.");
        return message.channel.send("לא מצאתי דיווח רווחים להיום.");
      }

      const formatted = items
        .map((e) => `• **${e.symbol}** at ${timeMap[e.hour] || e.hour}`)
        .join("\n");
      const result_message = `📈 **המדווחות בתאריך - ${today}:**\n${formatted}`;
      console.log(`returning message to user: ${JSON.stringify(result_message).substring(0, 300)}`);

      // send in chunks ≤3 900 chars to avoid Discord’s 4 000-char limit
      const maxLen = 3900;
      let buffer = "";
      for (const line of result_message.split("\n")) {
        if ((buffer + line + "\n").length > maxLen) {
          await message.channel.send(buffer);
          buffer = "";
        }
        buffer += line + "\n";
      }
      if (buffer) {
        await message.channel.send(buffer);
      }
    } catch (err) {
      console.error(err);
      await message.channel.send("❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים.");
    }
  }
});

client.login(DISCORD_TOKEN);
