import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import { handleTodaysEarnings } from "./cmd_handlers/todaysEarnings.mjs";
import { handleAnticipatedImage } from "./cmd_handlers/anticipatedImage.mjs";
import { sendHelp } from "./cmd_handlers/help.mjs";
import { listAllTickers } from "./cmd_handlers/listAllTickers.mjs";
import { listMyTickers } from "./cmd_handlers/listMyTickers.mjs";
import { listFirstByUser } from "./cmd_handlers/listFirstByUser.mjs";
import { handleGraphChannelMessage, runBackfillOnce } from "./cmd_handlers/graphChannelHandler.mjs";
import { showTickersDashboard, handleDashboardInteraction } from "./cmd_handlers/tickersDashboard.mjs";

// paths
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "scanner");
const DB_PATH = path.join(DATA_DIR, "db.json");
const ALL_TICKERS_PATH = path.join(DATA_DIR, "all_tickers.txt");

// env
const {
  DISCORD_TOKEN,
  FINNHUB_TOKEN,
  ANTICIPATED_CHANNEL_ID,
  BOT_CHANNEL_ID,
  GRAPHS_CHANNEL_ID,
  DISCORD_GUILD_ID,
  DISCORD_APPLICATION_ID,
} = process.env;

// shared state
let LIVE_LISTENING_ENABLED = false;

// slash command def
const commands = [
  new SlashCommandBuilder()
    .setName("todays_earnings")
    .setDescription("הצג את הטיקרים של החברות שמדווחות היום")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("איזה סוג של טיקרים להציג")
        .setRequired(false)
        .addChoices(
          { name: "All", value: "all" },
          { name: "S&P 500", value: "sp500" },
          { name: "Anticipated", value: "anticipated" },
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("הגבל את מספר הטיקרים המוצגים")
        .setMinValue(1)
        .setRequired(false)
    ),
].map((c) => c.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log("✅ Slash commands registered");
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await runBackfillOnce({
      client,
      channelId: GRAPHS_CHANNEL_ID,
      allTickersFile: ALL_TICKERS_PATH,
      dbPath: DB_PATH,
      lookbackDays: 14,
    });
    LIVE_LISTENING_ENABLED = true;
    console.log("✅ Backfill done; now listening for new messages.");
  } catch (e) {
    console.error("Backfill failed:", e);
    LIVE_LISTENING_ENABLED = true;
  }
});

// Interaction router (components first!)
client.on("interactionCreate", async (interaction) => {
  try {
    // Buttons/menus from the dashboard
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const handled = await handleDashboardInteraction({ interaction, dbPath: DB_PATH });
      if (handled) return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "todays_earnings") return;

    await interaction.deferReply(); // standard (non-ephemeral) is fine here
    const filter = interaction.options.getString("type") || "all";
    const limit  = interaction.options.getInteger("limit") || 0;

    if (filter === "anticipated") {
      await handleAnticipatedImage({ client, interaction, ANTICIPATED_CHANNEL_ID });
    } else {
      await handleTodaysEarnings({ client, interaction, filter, limit, FINNHUB_TOKEN });
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "❌ שגיאה בעיבוד הבקשה.", flags: 64 }).catch(() => {});
    } else {
      await interaction.reply({ content: "❌ שגיאה בעיבוד הבקשה.", flags: 64 }).catch(() => {});
    }
  }
});

// Message router
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const inBotRoom    = message.channel.id === BOT_CHANNEL_ID;
    const inGraphsRoom = message.channel.id === GRAPHS_CHANNEL_ID;

    if (inGraphsRoom) {
      if (!LIVE_LISTENING_ENABLED) return;
      const mentionsBot =
        (client.user?.id && message.mentions.users.has(client.user.id)) ||
        message.content?.includes("@SuperPony");
      if (!mentionsBot && message.content?.trim()) {
        await handleGraphChannelMessage({
          message,
          allTickersFile: ALL_TICKERS_PATH,
          dbPath: DB_PATH,
          silent: false,
          updateCheckpoint: true,
        });
      }
      return;
    }

    if (!inBotRoom) return;
    console.log(`🔔 New message in bot room: ${message.content}`);

    const content = message.content?.toLowerCase() || "";
    const mentionsBot = (client.user?.id && message.mentions.users.has(client.user.id)) || message.content?.includes("@SuperPony");
    console.log(`🔍 Mentions bot: ${mentionsBot}`);
    if (!mentionsBot) return;

    const otherMentions = message.mentions.users.filter(u => u.id !== client.user.id);
    console.log(`🔍 Other mentions: ${otherMentions.size}`);

    // Dashboard (primary entrypoint)
    if (content.includes("טיקרים")) {
      console.log(`📊 User ${message.author.tag} requested the dashboard`);
      await showTickersDashboard({ message, dbPath: DB_PATH });
      return;
    }

    // Mine
    if (content.includes("טיקרים שלי") || content.includes("שלי")) {
      console.log(`📈 User ${message.author.tag} requested their tickers`);
      await listMyTickers({ message, dbPath: DB_PATH });
      return;
    }

    // Other user tickers
    if (otherMentions.size > 0 && (content.includes("טיקרים") || content.includes("הטיקרים") || content.includes("של"))) {
      console.log(`🔍 User ${message.author.tag} requested tickers for: ${otherMentions.map(u => u.tag).join(", ")}`);
      const targetUser = otherMentions.first();
      await listFirstByUser({ message, dbPath: DB_PATH, targetUser });
      return;
    }

    // Earnings
    if (content.includes("דיווחים 500")) {
      console.log(`📈 User ${message.author.tag} requested S&P 500 earnings`);
      await handleTodaysEarnings({
        client,
        interaction: { channel: message.channel, followUp: (t) => message.channel.send(t) },
        filter: "sp500",
        limit: 0,
        FINNHUB_TOKEN,
      });
      return;
    }

    // List all tickers as an image
    if (content.includes("תמונת דיווחים") || content.includes("תמונה")) {
      console.log(`🖼️ User ${message.author.tag} requested anticipated earnings image`);
      await handleAnticipatedImage({
        client,
        interaction: { followUp: (t) => message.channel.send(t) },
        ANTICIPATED_CHANNEL_ID,
      });
      return;
    }

    // All earnings
    if (content.includes("דיווחים") || content.includes("מדווחות")) {
      console.log(`📈 User ${message.author.tag} requested all earnings`);
      await handleTodaysEarnings({
        client,
        interaction: { channel: message.channel, followUp: (t) => message.channel.send(t) },
        filter: "all",
        limit: 0,
        FINNHUB_TOKEN,
      });
      return;
    }

    // did not match any command - return help
    await sendHelp({ channel: message.channel });
  } catch (err) {
    console.error("messageCreate handler error:", err);
    if (message?.channel?.send) {
      await message.channel.send("❌ קרתה שגיאה בעיבוד הבקשה.");
    }
  }
});

await registerSlashCommands();
client.login(DISCORD_TOKEN);
