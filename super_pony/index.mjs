import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import axios from "axios";
import sharp from "sharp";

// 1️⃣ Load S&P-500 tickers (caches for 30 days)
const SP_FILE = path.resolve("./super_pony/sp500.json");
async function loadSP500() {
  try {
    const txt = await fs.readFile(SP_FILE, "utf-8");
    const { updated, symbols } = JSON.parse(txt);
    if ((Date.now() - Date.parse(updated)) / 86400000 < 30) {
      return symbols;
    }
  } catch {}
  const { data: csv } = await axios.get(
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv"
  );
  const symbols = csv
    .split("\n")
    .slice(1)
    .map((l) => l.split(",")[0])
    .filter(Boolean);
  await fs.writeFile(
    SP_FILE,
    JSON.stringify({ updated: new Date().toISOString(), symbols }, null, 2),
    "utf-8"
  );
  return symbols;
}

// 2️⃣ Env vars — make sure these are in your .env:
const {
  DISCORD_TOKEN,
  FINNHUB_TOKEN,
  BOT_CHANNEL_ID,
  ANTICIPATED_CHANNEL_ID,
  NEWS_API_KEY,
  DISCORD_GUILD_ID,          // ← set to your server’s ID
  DISCORD_APPLICATION_ID,    // ← set to your bot’s CLIENT_ID
} = process.env;

// 3️⃣ Time-of-day labels
const timeMap = {
  amc: "After Market Close",
  bmo: "Before Market Open",
  dmh: "During Market Hours",
  "": "Unknown Time",
};

// 4️⃣ Slash-command definition
const commands = [
  new SlashCommandBuilder()
    .setName("todays_earnings")
    .setDescription("Fetch today's earnings or most anticipated image")
    .addBooleanOption((o) =>
      o
        .setName("most_anticipated")
        .setDescription("Show most anticipated image instead of list")
    )
    .addIntegerOption((o) =>
      o
        .setName("limit")
        .setDescription("Max number of tickers to return")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
        .setAutocomplete(true)
    ),
].map((c) => c.toJSON());

// 5️⃣ Register the slash command in your guild
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(
      DISCORD_APPLICATION_ID,
      DISCORD_GUILD_ID
    ),
    { body: commands }
  );
})();

// 6️⃣ Start the bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.once("ready", () =>
  console.log(`✅ Logged in as ${client.user.tag}`)
);

// 7️⃣ Handle slash-command + autocomplete
client.on("interactionCreate", async (interaction) => {
  if (
    interaction.isAutocomplete() &&
    interaction.commandName === "todays_earnings"
  ) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "limit") {
      const choices = [10, 20, 50, 100];
      const filtered = choices
        .map((n) => n.toString())
        .filter((n) => n.startsWith(focused.value))
        .slice(0, 25);
      return interaction.respond(
        filtered.map((n) => ({ name: n, value: parseInt(n) }))
      );
    }
  }

  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "todays_earnings"
  ) {
    await interaction.deferReply();
    const mostAnticipated = interaction.options.getBoolean("most_anticipated");
    const limit = interaction.options.getInteger("limit");

    // —— If “most_anticipated”:
    if (mostAnticipated) {
      // …your existing image‐crop logic here, then:
      return interaction.followUp({ files: [/* AttachmentBuilder */] });
    }

    // —— Otherwise regular earnings list:
    try {
      const today = new Date().toISOString().split("T")[0];
      const { data } = await axios.get(
        `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`
      );
      let items = data.earningsCalendar || data;
      if (limit) items = items.slice(0, limit);
      if (/sp500/.test(interaction.options.getString("filter") || "")) {
        const sp500 = await loadSP500();
        items = items.filter((e) => sp500.includes(e.symbol));
      }
      // …group & chunk & send via interaction.followUp exactly as in your messageCreate version
    } catch (e) {
      console.error(e);
      await interaction.followUp(
        "❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים."
      );
    }
  }
});

client.login(DISCORD_TOKEN);

// 8️⃣ Your crop dimensions are still in the `presets` object you defined up top.
