// index.mjs
import "dotenv/config";
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
import { handleGraphChannelMessage } from "./cmd_handlers/graphChannelHandler.mjs";

const {
  DISCORD_TOKEN,
  FINNHUB_TOKEN,
  ANTICIPATED_CHANNEL_ID,
  BOT_CHANNEL_ID,
  GRAPHS_CHANNEL_ID,
  DISCORD_GUILD_ID,
  DISCORD_APPLICATION_ID,
} = process.env;

// ---- Slash command: /todays_earnings
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

// Register guild commands
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered");
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }
})();

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

// Slash command router
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "todays_earnings") return;

  await interaction.deferReply();

  const filter = interaction.options.getString("type") || "all";
  const limit = interaction.options.getInteger("limit") || 0;

  try {
    if (filter === "anticipated") {
      await handleAnticipatedImage({ client, interaction, ANTICIPATED_CHANNEL_ID });
    } else {
      await handleTodaysEarnings({ client, interaction, filter, limit, FINNHUB_TOKEN });
    }
  } catch (err) {
    console.error(err);
    await interaction.followUp("❌ שגיאה בעיבוד הבקשה.");
  }
});

// Single message listener (routes by channel)
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const inBotRoom = message.channel.id === BOT_CHANNEL_ID;
    const inGraphsRoom = message.channel.id === GRAPHS_CHANNEL_ID;

    // ——— GRAPHS channel: passive ticker logging (no @SuperPony mentions)
    if (inGraphsRoom) {
      const mentionsBot =
        (client.user?.id && message.mentions.users.has(client.user.id)) ||
        message.content?.includes("@SuperPony");
      if (!mentionsBot && message.content?.trim()) {
        await handleGraphChannelMessage({
          message,
          allTickersFile: "./scanner/all_tickers.txt",
          dbPath: "./scanner/db.json",
        });
      }
      return; // do not fall through to command handling
    }

    // ——— Not the bot commands room? ignore.
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
      await listMyTickers({ message });
    } else if (content.includes("טיקרים")) {
      await listAllTickers({ message });
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

client.on("error", (err) => console.error("Discord client error:", err));

process.on("SIGINT", () => client.destroy().then(() => process.exit(0)));
process.on("SIGTERM", () => client.destroy().then(() => process.exit(0)));

client.login(DISCORD_TOKEN);
