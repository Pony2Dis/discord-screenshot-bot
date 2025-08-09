import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { exec as execCb } from "child_process";

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
import {
  handleGraphChannelMessage,
  runBackfillOnce,
  flushTickerDbWrites,
} from "./cmd_handlers/graphChannelHandler.mjs";

const exec = promisify(execCb);

// ——— paths ———
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "scanner");
const DB_PATH = path.join(DATA_DIR, "db.json");
const ALL_TICKERS_PATH = path.join(DATA_DIR, "all_tickers.txt");

// ——— env ———
const {
  DISCORD_TOKEN,
  FINNHUB_TOKEN,
  ANTICIPATED_CHANNEL_ID,
  BOT_CHANNEL_ID,
  GRAPHS_CHANNEL_ID,
  DISCORD_GUILD_ID,
  DISCORD_APPLICATION_ID,
} = process.env;

// ——— shared state ———
let client;
let LIVE_LISTENING_ENABLED = false;
let handlersBound = false;

// Slash command definition
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

// Optional: commit DB on shutdown (only if changed)
async function commitDbIfChanged() {
  try {
    await exec('git config user.name "github-actions[bot]"');
    await exec('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');

    await exec(`git add "${DB_PATH}"`);
    let hasChanges = false;
    try {
      await exec("git diff --cached --quiet");
    } catch {
      hasChanges = true;
    }
    if (!hasChanges) return;

    await exec('git commit -m "chore(scanner): update db.json [skip ci]"');
    await exec("git push");
    console.log("✅ Pushed db.json changes.");
  } catch (e) {
    console.error("git push failed:", e?.message || e);
  }
}

/** Exported: run the job until runner aborts */
export async function runJob(ctx) {
  const { signal, log } = ctx;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", async () => {
    log.log(`✅ Logged in as ${client.user.tag}`);
    try {
      await runBackfillOnce({
        client,
        channelId: GRAPHS_CHANNEL_ID,
        allTickersFile: ALL_TICKERS_PATH,
        dbPath: DB_PATH,
        lookbackDays: 14,
      });
      LIVE_LISTENING_ENABLED = true;
      log.log("✅ Backfill done; now listening for new messages.");
    } catch (e) {
      console.error("Backfill failed:", e);
      LIVE_LISTENING_ENABLED = true; // enable anyway
    }
  });

  // Slash command router
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "todays_earnings") return;

      await interaction.deferReply();

      const filter = interaction.options.getString("type") || "all";
      const limit = interaction.options.getInteger("limit") || 0;

      if (filter === "anticipated") {
        await handleAnticipatedImage({ client, interaction, ANTICIPATED_CHANNEL_ID });
      } else {
        await handleTodaysEarnings({ client, interaction, filter, limit, FINNHUB_TOKEN });
      }
    } catch (err) {
      console.error(err);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp("❌ שגיאה בעיבוד הבקשה.");
      } else {
        await interaction.reply("❌ שגיאה בעיבוד הבקשה.");
      }
    }
  });

  // Single message listener (routes by channel)
  if (!handlersBound) {
    handlersBound = true;
    client.on("messageCreate", async (message) => {
      try {
        if (message.author.bot) return;

        const inBotRoom = message.channel.id === BOT_CHANNEL_ID;
        const inGraphsRoom = message.channel.id === GRAPHS_CHANNEL_ID;

        // GRAPHS channel: passive ticker logging (no @SuperPony mentions)
        if (inGraphsRoom) {
          if (!LIVE_LISTENING_ENABLED) return; // wait until backfill finished
          const mentionsBot =
            (client.user?.id && message.mentions.users.has(client.user.id)) ||
            message.content?.includes("@SuperPony");
          if (!mentionsBot && message.content?.trim()) {
            await handleGraphChannelMessage({
              message,
              allTickersFile: ALL_TICKERS_PATH,
              dbPath: DB_PATH,
              silent: false,
              updateCheckpoint: true, // store checkpoint per processed message
            });
          }
          return; // do not fall through to command handling
        }

        // Not bot commands room? ignore.
        if (!inBotRoom) return;

        // Command-style text handling in the bot room
        const content = message.content?.toLowerCase() || "";

        if (content.startsWith("pony say hello")) {
          await message.channel.send("Hello! I'm Super Pony, your friendly bot!");
          return;
        }

        const mentionsBot =
          (client.user?.id && message.mentions.users.has(client.user.id)) ||
          message.content?.includes("@SuperPony");

        if (!mentionsBot) return;

        if (content.includes("טיקרים שלי") || content.includes("שלי")) {
          await listMyTickers({ message, dbPath: DB_PATH });
        } else if (content.includes("טיקרים")) {
          await listAllTickers({ message, dbPath: DB_PATH, includeCounts: true, minMentions: 1 });
        } else if (content.includes("דיווחים 500")) {
          await handleTodaysEarnings({
            client,
            interaction: { channel: message.channel, followUp: (t) => message.channel.send(t) },
            filter: "sp500",
            limit: 0,
            FINNHUB_TOKEN,
          });
        } else if (content.includes("דיווחים") || content.includes("מדווחות")) {
          await handleTodaysEarnings({
            client,
            interaction: { channel: message.channel, followUp: (t) => message.channel.send(t) },
            filter: "all",
            limit: 0,
            FINNHUB_TOKEN,
          });
        } else if (content.includes("תמונת דיווחים") || content.includes("תמונה")) {
          await handleAnticipatedImage({
            client,
            interaction: { followUp: (t) => message.channel.send(t) },
            ANTICIPATED_CHANNEL_ID,
          });
        } else if (
          content.includes("עזרה") ||
          content.includes("מה אתה יודע לעשות") ||
          content.includes("רשימת פקודות") ||
          content.includes("help") ||
          content.includes("תעזור") ||
          content.includes("commands")
        ) {
          await sendHelp({ channel: message.channel });
        } else {
          await sendHelp({ channel: message.channel });
        }
      } catch (err) {
        console.error("messageCreate handler error:", err);
        if (message?.channel?.send) {
          await message.channel.send("❌ קרתה שגיאה בעיבוד הבקשה.");
        }
      }
    });
  }

  // Register slash commands then login
  await registerSlashCommands();
  await client.login(DISCORD_TOKEN);

  // Keep alive until runner aborts
  await new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", resolve, { once: true });
  });
}

/** Exported: graceful cleanup */
export async function shutdown(ctx, reason, error) {
  const { log } = ctx;
  log?.warn?.(`⚠️  shutdown (${reason})`);
  if (error) console.error(error);

  try {
    await flushTickerDbWrites();
  } catch (e) {
    console.error("flushTickerDbWrites failed:", e);
  }

  try {
    await commitDbIfChanged(); // remove if you don't want commits here
  } catch (e) {
    console.error("commitDbIfChanged failed:", e);
  }

  try {
    await client?.destroy();
  } catch (e) {
    console.error("client.destroy failed:", e);
  }
}
