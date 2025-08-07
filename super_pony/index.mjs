import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import axios from "axios";
import sharp from "sharp";

// S&P 500 cache file and loader
const SP_FILE = path.resolve("./super_pony/sp500.json");
async function loadSP500() {
  try {
    const txt = await fs.readFile(SP_FILE, "utf-8");
    const { updated, symbols } = JSON.parse(txt);
    if ((Date.now() - Date.parse(updated)) / 86400000 < 30) {
      return symbols;
    }
  } catch {}
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

const {
  DISCORD_TOKEN,
  FINNHUB_TOKEN,
  BOT_CHANNEL_ID,
  ANTICIPATED_CHANNEL_ID,
  NEWS_API_KEY,
} = process.env;

const timeMap = {
  amc: "After Market Close",
  bmo: "Before Market Open",
  dmh: "During Market Hours",
  "": "Unknown Time",
};

// Register slash command with options
const commands = [
    new SlashCommandBuilder()
      .setName("todays_earnings")
      .setDescription("Fetch today's earnings or most anticipated image")
      .addBooleanOption((opt) =>
        opt
          .setName("most_anticipated")
          .setDescription("Show most anticipated image instead of list")
      )
      .addIntegerOption((opt) =>
        opt
          .setName("limit")
          .setDescription("Max number of tickers to return")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)
          .setAutocomplete(true)
      ),
  ].map((c) => c.toJSON());
  
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  (async () => {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
  })();
  
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
  const content = message.content.toLowerCase();
  if (!content.startsWith("/todays earnings")) return;

  // —————————————————————————
  // 1️⃣ “Most anticipated” → image crop
  if (content.includes("most anticipated")) {
    await message.channel.send("🔄 שולף את התמונה ומגזם לטיקרים של היום...");
    try {
      const ch = await client.channels.fetch(ANTICIPATED_CHANNEL_ID);
      const fetched = await ch.messages.fetch({ limit: 10 });
      const imgMsg = fetched.find(
        (m) =>
          m.attachments.size > 0 ||
          m.embeds.some((e) => e.image || e.thumbnail)
      );
      if (!imgMsg)
        return message.channel.send("❌ לא נמצאה תמונה שהתפרסמה.");

      const url =
        imgMsg.attachments.size > 0
          ? imgMsg.attachments.first().url
          : imgMsg.embeds.find((e) => e.image || e.thumbnail).image?.url ||
            imgMsg.embeds.find((e) => e.image || e.thumbnail).thumbnail?.url;
      const resp = await axios.get(url, { responseType: "arraybuffer" });
      const imgBuf = Buffer.from(resp.data);

      const presets = {
        1: { left: 5, top: 80, width: 265, height: 587 },
        2: { left: 267, top: 80, width: 265, height: 587 },
        3: { left: 532, top: 80, width: 265, height: 587 },
        4: { left: 795, top: 80, width: 265, height: 587 },
        5: { left: 1059, top: 80, width: 140, height: 587 },
      };
      const day = new Date().getDay();
      const region = presets[day] || presets[1];

      const cropped = await sharp(imgBuf).extract(region).toBuffer();
      const file = new AttachmentBuilder(cropped, { name: "today.png" });
      await message.channel.send({ files: [file] });
    } catch (err) {
      console.error(err);
      await message.channel.send("❌ שגיאה בחיתוך התמונה.");
    }
    return;
  }

  // —————————————————————————
  // 2️⃣ Regular “/todays earnings” → finnhub + filters
  await message.channel.send("🔄 שולף את הטיקרים של המדווחות להיום...");
  try {
    const today = new Date().toISOString().split("T")[0];
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`;
    const resp = await axios.get(url);
    let items = resp.data.earningsCalendar || resp.data;

    // limit:N
    const limitMatch = content.match(/limit:\s*(\d+)/);
    if (limitMatch) items = items.slice(0, +limitMatch[1]);

    // sp500
    if (/sp500/.test(content)) {
      const sp500List = await loadSP500();
      items = items.filter((e) => sp500List.includes(e.symbol));
    }

    // topNews:N
    const newsMatch = content.match(/topnews:\s*(\d+)/);
    if (newsMatch && NEWS_API_KEY) {
      const topN = +newsMatch[1];
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
      return message.channel.send("לא מצאתי דיווח רווחים להיום.");
    }

    const groups = items.reduce((acc, e) => {
      const label = timeMap[e.hour] || e.hour;
      (acc[label] = acc[label] || []).push(e.symbol);
      return acc;
    }, {});
    const order = [
      "Before Market Open",
      "During Market Hours",
      "After Market Close",
      "Unknown Time",
    ];

    const maxLen = 1900;
    for (const label of order) {
      const syms = groups[label] || [];
      if (!syms.length) continue;

      let chunk = `===================\n**${label}:**\n===================\n`;
      for (const sym of syms) {
        const part = `${sym}, `;
        if ((chunk + part).length > maxLen) {
          await message.channel.send(chunk.replace(/, $/, ""));
          chunk = "";
        }
        chunk += part;
      }
      await message.channel.send(chunk.replace(/, $/, ""));
    }
  } catch (err) {
    console.error(err);
    await message.channel.send(
      "❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים."
    );
  }
});

client.login(DISCORD_TOKEN);
