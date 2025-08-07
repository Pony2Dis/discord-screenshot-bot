import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { Client, GatewayIntentBits } from "discord.js";
import axios from "axios";

// S&P 500 cache file and loader
const SP_FILE = path.resolve("./super_pony/sp500.json");
async function loadSP500() {
  try {
    const txt = await fs.readFile(SP_FILE, "utf-8");
    const { updated, symbols } = JSON.parse(txt);
    const daysOld = (Date.now() - Date.parse(updated)) / 86400000;
    if (daysOld < 30) return symbols;
  } catch {
    // no cache or invalid, will refresh
  }
  const csvUrl =
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv";
  const { data: csv } = await axios.get(csvUrl);
  const symbols = csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0])
    .filter(Boolean);
  await fs.writeFile(
    SP_FILE,
    JSON.stringify({ updated: new Date().toISOString(), symbols }, null, 2),
    "utf-8"
  );
  return symbols;
}

const { DISCORD_TOKEN, FINNHUB_TOKEN, BOT_CHANNEL_ID, NEWS_API_KEY } =
  process.env;

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
    console.log(
      `Fetching today's earnings for channel: ${message.channel.id}`
    );

    try {
      const today = new Date().toISOString().split("T")[0];
      const url =
        `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`;
      console.log(`Fetching from URL: ${url}`);
      const resp = await axios.get(url);
      if (resp.status !== 200) {
        throw new Error(`Unexpected status code: ${resp.status}`);
      }

      console.log(
        `Response data: ${JSON.stringify(resp.data).substring(0, 300)}`
      );
      let items = resp.data.earningsCalendar || resp.data;

      // limit:N
      const limitMatch = message.content.match(/limit:\s*(\d+)/i);
      if (limitMatch) {
        const l = parseInt(limitMatch[1], 10);
        console.log(`Applying limit: ${l}`);
        items = items.slice(0, l);
      }

      // sp500
      if (/sp500/i.test(message.content)) {
        console.log("Filtering for S&P 500 constituents");
        const sp500List = await loadSP500();
        items = items.filter((e) => sp500List.includes(e.symbol));
        console.log(`After SP500 filter: ${items.length} items remain`);
      }

      // topNews:N
      const newsMatch = message.content.match(/topnews:\s*(\d+)/i);
      if (newsMatch && NEWS_API_KEY) {
        const topN = parseInt(newsMatch[1], 10);
        console.log(`Filtering top ${topN} by news volume`);
        const counts = await Promise.all(
          items.map(async (e) => {
            const { data } = await axios.get(
              "https://newsapi.org/v2/everything",
              {
                params: {
                  q: e.symbol,
                  from: today,
                  language: "en",
                  apiKey: NEWS_API_KEY,
                },
              }
            );
            return { item: e, count: data.totalResults || 0 };
          })
        );
        counts.sort((a, b) => b.count - a.count);
        items = counts.slice(0, topN).map((c) => c.item);
      }

      if (!items.length) {
        console.log("No earnings found for today.");
        return message.channel.send("לא מצאתי דיווח רווחים להיום.");
      }

      // group & send
      const groups = items.reduce((acc, e) => {
        const label = timeMap[e.hour] || e.hour;
        acc[label] = acc[label] || [];
        acc[label].push(e.symbol);
        return acc;
      }, {});
      const order = [
        "Before Market Open",
        "During Market Hours",
        "After Market Close",
        "Unknown Time",
      ];

      console.log(
        `returning grouped sections: ${JSON.stringify(groups).substring(0, 300)}`
      );

      const maxLen = 1900;
      for (const label of order) {
        const syms = groups[label] || [];
        if (!syms.length) continue;

        let chunk = `===================\n**${label}:**\n===================\n`;
        for (const sym of syms) {
          const addition = `${sym}, `;
          if ((chunk + addition).length > maxLen) {
            await message.channel.send(chunk.trim().replace(/, $/, ""));
            chunk = "";
          }
          chunk += addition;
        }
        await message.channel.send(chunk.trim().replace(/, $/, ""));
      }
    } catch (err) {
      console.error(err);
      await message.channel.send(
        "❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים."
      );
    }
  }
});

client.login(DISCORD_TOKEN);
