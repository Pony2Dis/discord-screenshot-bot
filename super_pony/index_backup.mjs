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
  ANTICIPATED_CHANNEL_ID,
  BOT_CHANNEL_ID,
  DISCORD_GUILD_ID,
  DISCORD_APPLICATION_ID,
} = process.env;

const helpString = ```
כדי שאדע שאתם מדברים אלי, תזכירו אותי בהודעה שלכם, תוסיפו את השם שלי (SuperPony) או תשתמשו בפקודה @SuperPony.

הנה רשימת הפקודות שאני יודע לבצע:
1. להראות את כל הטיקרים שבמעקב בחוכמת הסורק, פשוט תרשמו לי: טיקרים
לדוגמה: @SuperPony טיקרים

2. להציג את כל הטיקרים שאבמעקב שאתה ציינת ראשון, פשוט תרשמו לי: טירקים שלי
לדוגמה: @SuperPony טיקרים שלי
או: @SuperPony שלי 

3. להציג את כל הטיקרים של חברות שמדווחות היום, פשוט תרשמו לי: דיווחים או מדווחות
לדוגמה: @SuperPony דיווחים
או: @SuperPony מדווחות

4. להציג תמונה של החברות שהכי מצפים לדיווח שלהן היום, פשוט תרשמו לי: תמונת דיווחים או תמונה
לדוגמה: @SuperPony תמונת דיווחים
או: @SuperPony תמונה

5. להציג את כל הטיקרים של חברות שהן חלק ממדד ה-סאפ 500 שמדווחות היום, פשוט תרשמו לי: דיווחים 500
לדוגמה: @SuperPony דיווחים 500
```;
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
    .setDescription("הצג את הטיקרים של החברות שמדווחות היום")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("איזה סוג של טיקרים להציג")
        .setRequired(false)
        .addChoices(
          {
            name: "All",
            value: "all",
            description: "הצג את כל החברות שמדווחות היום",
          },
          {
            name: "S&P 500",
            value: "sp500",
            description: "הצג רק את חברות שהן חלק ממדד ה-S&P 500 שמדווחות היום",
          },
          {
            name: "Anticipated",
            value: "anticipated",
            description: "הצג תמונה של החברות שהכי מצפים לדיווח שלהן היום",
          }
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

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID),
    {
      body: commands,
    }
  );
})();

// Create a new Discord client with necessary intents (connect to discord and login)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

// 7️⃣ Handle slash-command + autocomplete
client.on("interactionCreate", async (interaction) => {
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "todays_earnings"
  ) {
    await interaction.deferReply();

    const limit = interaction.options.getInteger("limit") || 0; // 0 means no limit
    const filter = interaction.options.getString("type") || "all";

    if (filter === "anticipated") {
      // —— If “anticipated”:
      try {
        const channel = await client.channels.fetch(ANTICIPATED_CHANNEL_ID);
        const fetched = await channel.messages.fetch({ limit: 10 });
        const imgMsg = fetched.find(
          (m) =>
            m.attachments.size > 0 ||
            m.embeds.some((e) => e.image || e.thumbnail)
        );
        if (!imgMsg) {
          return interaction.followUp("❌ לא נמצאה תמונה שהתפרסמה.");
        }

        const url =
          imgMsg.attachments.size > 0
            ? imgMsg.attachments.first().url
            : imgMsg.embeds.find((e) => e.image || e.thumbnail).image?.url ||
              imgMsg.embeds.find((e) => e.image || e.thumbnail).thumbnail?.url;

        const resp = await axios.get(url, { responseType: "arraybuffer" });
        const imgBuf = Buffer.from(resp.data);

        // Define the cropping presets based on the day of the week
        const presets = {
          1: { left: 5, top: 80, width: 265, height: 587 },
          2: { left: 267, top: 80, width: 265, height: 587 },
          3: { left: 532, top: 80, width: 265, height: 587 },
          4: { left: 795, top: 80, width: 265, height: 587 },
          5: { left: 1059, top: 80, width: 140, height: 587 },
        };

        // Use Israel-local date to pick the correct crop
        const israelDate = new Date(
          new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" })
        );
        const day = israelDate.getDay(); // 0=Sun … 6=Sat
        console.log(`Today is day ${day} of the week (0=Sun, 6=Sat)`);

        // Get the cropping region based on the day of the week
        const region = presets[day] || presets[1];

        // Crop the image using sharp
        const cropped = await sharp(imgBuf).extract(region).toBuffer();

        // 🟢 Create an attachment and send it as a reply
        const file = new AttachmentBuilder(cropped, { name: "today.png" });
        return interaction.followUp({ files: [file] });
      } catch (err) {
        console.error(err);
        return interaction.followUp("❌ שגיאה בחיתוך התמונה.");
      }
    } else {
      // —— If “sp500” or “all”:
      try {
        const sp500 = await loadSP500();
        // const today = new Date().toISOString().split("T")[0];
        const today = new Date().toLocaleDateString("en-US", {
          timeZone: "Asia/Jerusalem",
        });
        console.log(`Fetching earnings for today: ${today}`);

        const { data } = await axios.get(
          `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`
        );
        let items = data.earningsCalendar || data;

        // Apply S&P 500 filter if specified
        if (filter === "sp500") {
          items = items.filter((e) => sp500.includes(e.symbol));
        }

        // Apply limit if specified
        if (limit) items = items.slice(0, limit);

        if (!items.length) {
          return interaction.followUp("לא מצאתי דיווח רווחים להיום.");
        }

        // Group and chunk the results
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

        // connect to the channel in order to send messages
        const channel = await client.channels.fetch(interaction.channelId);

        const maxLen = 1900;
        for (const label of order) {
          const syms = groups[label] || [];
          if (!syms.length) continue;

          let chunk = `—————————————————————————\n**${label}:**\n—————————————————————————\n`;
          for (const sym of syms) {
            const part = `${sym}, `;
            if ((chunk + part).length > maxLen) {
              await channel.send(chunk.replace(/, $/, ""));
              chunk = "";
            }
            chunk += part;
          }
          await channel.send(chunk.replace(/, $/, ""));
        }

        return interaction.followUp(
          `נמצאו ${items.length} דיווחי רווחים להיום.`
        );
      } catch (e) {
        console.error(e);
        return interaction.followUp(
          "❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים."
        );
      }
    }
  }
});

// 6️⃣ Handle message commands
client.on("messageCreate", async (message) => {
  if (message.channel.id !== BOT_CHANNEL_ID || message.author.bot) return;

  // get the message content in lowercase for easier matching
  const content = message.content.toLowerCase();

  // check if this is the test message
  if (content.startsWith("pony say hello")) {
    // Respond to the message with a simple greeting
    await message.channel.send("Hello! I'm Super Pony, your friendly bot!");
  }

  // check if the bot is mentioned, searching for @SuperPony
  if (content.includes(`<@${client.user.id}>`) || content.includes("@SuperPony")) {
    // check what the user is asking for
    if (content.includes("טיקרים שלי") || content.includes("שלי")) {
      // If the user asks for today's earnings, send a message with instructions
      await message.channel.send(
        "אלו כל הטיקרים שלך שאני עוקב אחריהם:\n"
      );
    } else if (content.includes("טיקרים")) {
      await message.channel.send(
        "אלו כל הטיקרים שאני עוקב אחריהם:\n"
      );
    } else if (content.includes("דיווחים") || content.includes("מדווחות")) {
      // If the user asks for today's earnings, send a message with instructions
      await message.channel.send(
        "אלו כל הטיקרים של החברות שמדווחות היום:\n"
      );
    } else if (content.includes("תמונת דיווחים") || content.includes("תמונה")) {
      // If the user asks for the anticipated earnings image, send a message with instructions
      await message.channel.send(
        "אלו כל הטיקרים של החברות שהכי מצפים לדיווח שלהן היום:\n"
      );
    } else if (content.includes("דיווחים 500")) {
      // If the user asks for today's earnings from S&P 500 companies, send a message with instructions
      await message.channel.send(
        "אלו כל הטיקרים של חברות שמדווחות היום ומדד ה-S&P 500:\n"
      );
    } else if (content.includes("עזרה") || content.includes("מה אתה יודע לעשות") || content.includes("רשימת פקודות") || content.includes("help") || content.includes("תעזור") || content.includes("commands")) {
      // If the user asks for help, send a message with available commands
      await message.channel.send(helpString);
    } else {
      // If the user asks something else, send a generic response
      await message.channel.send("לא הצלחתי להבין את הבקשה, " + helpString);
    }
  }
});

client.login(DISCORD_TOKEN);

client.on("error", (err) => {
  console.error("Discord client error:", err);
});

process.on("SIGINT", () => client.destroy().then(() => process.exit(0)));
process.on("SIGTERM", () => client.destroy().then(() => process.exit(0)));
