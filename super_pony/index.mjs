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

  // Existing earnings logic
  if (content.startsWith("/todays earnings") && !content.includes("most anticipated")) {
    // ... existing code unchanged ...
    return;
  }

  // Most anticipated image crop
  if (content === "/todays earnings most anticipated") {
    await message.channel.send("🔄 שולף את התמונה ומגזם לטיקרים של היום...");
    try {
      // fetch the last image message from the designated channel
      const ch = await client.channels.fetch(ANTICIPATED_CHANNEL_ID);
      const fetched = await ch.messages.fetch({ limit: 10 });
      const imgMsg = fetched.find(msg => msg.attachments.size > 0);
      if (!imgMsg) {
        return message.channel.send("❌ לא נמצאה תמונה שהתפרסמה.");
      }
      const attachment = imgMsg.attachments.first();
      if (!attachment || !attachment.url) {
        return message.channel.send("❌ התמונה אינה נגישה.");
      }
      const url = attachment.url;

      // download image
      const resp = await axios.get(url, { responseType: 'arraybuffer' });
      const imgBuf = Buffer.from(resp.data);

      // determine crop region based on weekday
      const day = new Date().getDay();
      // Monday=1,...Friday=5; map to index 0-4
      const colIndex = Math.min(Math.max(day - 1, 0), 4);

      const meta = await sharp(imgBuf).metadata();
      const colWidth = Math.floor(meta.width / 5);
      const region = {
        left: colIndex * colWidth,
        top: 0,
        width: colWidth,
        height: meta.height,
      };

      const cropped = await sharp(imgBuf)
        .extract(region)
        .toBuffer();

      // send cropped image
      const file = new AttachmentBuilder(cropped, { name: 'today.png' });
      await message.channel.send({ files: [file] });
    } catch (err) {
      console.error(err);
      await message.channel.send("❌ שגיאה בחיתוך התמונה.");
    }
  }
});

client.login(DISCORD_TOKEN);
