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
import { deleteAndRepost } from "./cmd_handlers/deleteAndRepost.mjs";

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
  LOG_CHANNEL_ID,
  GRAPHS_CHANNEL_ID,
  DISCORD_GUILD_ID,
  DISCORD_APPLICATION_ID,
  SHUTDOWN_SECRET,
} = process.env;

// shared state
let LIVE_LISTENING_ENABLED = false;

let botLogChannel = null; // channel for bot logs
let botChannel = null; // channel for bot interactions

// graceful shutdown (NEW)
async function shutdown(reason = "discord-webhook") {
  try {
    console.log(`🛑 Shutting down (${reason})...`);
    if (client) await client.destroy();
  } catch (e) {
    console.error("Error during shutdown:", e);
  } finally {
    process.exit(0);
  }
}

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
    botLogChannel = client.channels.cache.get(LOG_CHANNEL_ID);
    if (!botLogChannel) {
      console.warn("Bot Log channel not found, wont be able to delete and repost.");
    }

    botChannel = client.channels.cache.get(BOT_CHANNEL_ID);
    if (botChannel) {
      await botChannel.send("🔵 מבצע סריקה של הטיקרים בחדר גרפים...");
    } else {
      console.warn("Bot channel not found, skipping scanning message.");
    }

    try {
      await runBackfillOnce({
        client,
        channelId: GRAPHS_CHANNEL_ID,
        allTickersFile: ALL_TICKERS_PATH,
        dbPath: DB_PATH,
        lookbackDays: 14,
      });
    } catch (e) {
      console.error("Backfill failed:", e);
    }
  
    LIVE_LISTENING_ENABLED = true;
    console.log("✅ Backfill done; now listening for new messages.");
    if (botChannel) {
      await botChannel.send("🟢 חזרתי לפעילות, אני זמין, שלחו לי הודעה!");
    } else {
      console.warn("Bot channel not found, skipping ready message.");
    }
  } catch (e) {
    console.error("Error occured:", e);
    LIVE_LISTENING_ENABLED = true;
  }
});

// Interaction router (components first!)
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const handled = await handleDashboardInteraction({ interaction, dbPath: DB_PATH });
      if (handled) return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "todays_earnings") return;

    await interaction.deferReply();
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
    // --- NEW: special path for Discord webhook messages ---
    if (message.webhookId) {
      if (message.channel.id === LOG_CHANNEL_ID) {
        const text = (message.content || "").trim();
        if (text === `shutdown ${SHUTDOWN_SECRET}`) {
          // send a message to the bot channel before shutdown
          console.log("🔴 Shutdown command received via webhook, shutting down...");
          if (botChannel) {
            await botChannel.send("🔴 אני יורד לדקה של תחזוקה...");
          } else {
            console.warn("Bot channel not found, skipping shutdown message.");
          }
          return shutdown();
        }
      }
      return; // ignore other webhook messages
    }

    // if the message is from a bot, ignore it
    if (message.author.bot) return;

    const inBotRoom    = message.channel.id === BOT_CHANNEL_ID;
    const inGraphsRoom = message.channel.id === GRAPHS_CHANNEL_ID;

    // if the message is sent in the graphs room, handle it
    if (inGraphsRoom) {
      if (!LIVE_LISTENING_ENABLED) return;
      if (message.content?.trim()) {
        // first log user's message in the DB
        await handleGraphChannelMessage({
          message,
          allTickersFile: ALL_TICKERS_PATH,
          dbPath: DB_PATH,
          silent: true,
          updateCheckpoint: true,
        });

        // then delete the original message and repost it in this channel as the bot
        // const USERS_TO_PROTECT = ["pony"];
        // initials for the users to protect
        // const USER_INITIALS = ["pny"];

        console.log(`📥 New message in #${message.channel.name} from ${message.author.username}`);
        // if USERS_TO_PROTECT strings are in the message author username, delete and repost the message
        // if(USERS_TO_PROTECT.some(u => message.author.username.toLowerCase().includes(u))) {
          // const userIndex = USERS_TO_PROTECT.findIndex(u => message.author.username.toLowerCase().includes(u));
          // const userInitials = USER_INITIALS[userIndex] || "user"; // default to "user" if not found
          // remove from username all the letters a,i,o,e,u and replace with empty string, then take the first three letters and make that the user initials
          let userInitials = message.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny"; // default to "user" if empty
          // if the user initials are longer than 3 characters, truncate to 3
          if (userInitials.length > 3) {
            userInitials = userInitials.substring(0, 3);
          }
          console.log(`🔄 Reposting message from ${message.author.tag} in #${message.channel.name} as ${userInitials}`);
          
          try {
            await deleteAndRepost(message, botLogChannel, userInitials);
            console.log(`🔄 Reposted message from ${message.author.tag} in #${message.channel.name}`);
          } catch (err) {
            console.error(`❌ Failed to repost message from ${message.author.tag} in #${message.channel.name}:`, err);
            if (message.channel.send) {
              await message.channel.send(`❌ לא הצלחתי לפרסם את ההודעה שלך, אנא נסה שוב, או פנה למנהל השרת.`);
            }
          }
        // }
      }
      return;
    }

    // if the message is sent in a room other than the bot room, ignore it
    if (!inBotRoom) return;

    // if the message has the bot name or mentions the bot, handle it
    const content = message.content?.toLowerCase() || "";
    const mentionsBot = (client.user?.id && message.mentions.users.has(client.user.id)) || content.includes("@superpony") || content.includes("1398710664079474789");
    // console.log(`🔔 Message from: ${message.author.tag}, in channel: ${message.channel.name}, mentions: ${message.mentions.users}, content: `, content);
    if (!mentionsBot) return;

    const otherMentions = message.mentions.users.filter(u => u.id !== client.user.id);

    // Mine
    if (otherMentions.size == 0 && (content.includes("טיקרים שלי") || content.includes("שלי"))) {
      console.log(`📈 User ${message.author.tag} requested their tickers`);
      await listMyTickers({ message, dbPath: DB_PATH });
      return;
    }

    // List all tickers
    if (otherMentions.size == 0 && (content.includes("כל הטיקרים") || content.includes("כל טיקרים"))) {
      console.log(`📜 User ${message.author.tag} requested the full ticker list`);
      await listAllTickers({ message, dbPath: DB_PATH});
      return;
    }

    // Dashboard (primary entrypoint)
    if (otherMentions.size == 0 && content.includes("טיקרים")) {
      console.log(`📊 User ${message.author.tag} requested the dashboard`);
      await showTickersDashboard({ message, dbPath: DB_PATH });
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


// global error handlers
process.on("unhandledRejection", (err) => {
  console.error("UnhandledRejection:", err);
  shutdown();
});

process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
  shutdown();
});


await registerSlashCommands();
client.login(DISCORD_TOKEN);
