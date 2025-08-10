import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { DISCORD_TOKEN, RELAY_ROUTS } = process.env;

const STATE_FILE = path.join(__dirname, "lastMessageIds.json");

// --- utils ---
function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {}
  return fallback;
}
function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// --- load config/state ---
let routes;
try {
  routes = JSON.parse(RELAY_ROUTS || "[]");
} catch (err) {
  console.error("❌ Failed to parse RELAY_ROUTS JSON:", err.message);
  process.exit(1);
}

if (!Array.isArray(routes) || routes.length === 0) {
  console.error("❌ No valid routes in RELAY_ROUTS variable");
  process.exit(1);
}

const lastMap = loadJson(STATE_FILE, {}); // { [sourceId]: lastId }

// --- discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on("error", (e) => console.error("Discord client error:", e));
client.on("shardError", (e) => console.error("Shard error:", e));

(async () => {
  console.log("Logging in to Discord...");
  await client.login(DISCORD_TOKEN);

  try {
    for (const { source, target } of routes) {
      if (!source || !target) continue;

      console.log(`\n=== Route: ${source} -> ${target} ===`);
      const sourceChan = await client.channels.fetch(source).catch(() => null);
      const targetChan = await client.channels.fetch(target).catch(() => null);

      if (!sourceChan) {
        console.warn(`⚠️ Source channel not found: ${source}`);
        continue;
      }
      if (!targetChan) {
        console.warn(`⚠️ Target channel not found: ${target}`);
        continue;
      }

      const lastId = lastMap[source] || null;
      const options = lastId ? { after: lastId, limit: 100 } : { limit: 100 };
      console.log(`Fetching messages with options:`, options);

      const fetched = await sourceChan.messages.fetch(options);
      const sorted = Array.from(fetched.values())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      console.log(`Fetched ${sorted.length} new messages`);

      for (const msg of sorted) {
        if (!msg?.id) continue;
        if (!msg.content?.trim() && !msg.embeds?.length && !msg.attachments?.size) {
          lastMap[source] = msg.id;
          continue;
        }

        const payload = {
          ...(msg.content && { content: msg.content }),
          ...(msg.embeds?.length && { embeds: msg.embeds.map(e => e.toJSON()) }),
          ...(msg.attachments?.size && {
            files: msg.attachments.map(a => ({ attachment: a.url, name: a.name }))
          })
        };

        console.log(`Relaying message ${msg.id} -> ${target}`);
        await targetChan.send(payload);
        lastMap[source] = msg.id;
        await sleep(200);
      }
    }

    console.log("\nSaving state...");
    saveJson(STATE_FILE, lastMap);
  } catch (err) {
    console.error("Relay error:", err);
  } finally {
    console.log("Disconnecting client...");
    await client.destroy().catch(() => {});
  }
})();
