import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { REST, Routes, WebhookClient } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { DISCORD_TOKEN, RELAY_ROUTS } = process.env;

if (!DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --- load config/state ---
let routes;
try {
  routes = JSON.parse(RELAY_ROUTS || "[]"); // [{ source: "123", target: "456" | "https://discord.com/api/webhooks/..." }]
} catch (err) {
  console.error("❌ Failed to parse RELAY_ROUTS JSON:", err.message);
  process.exit(1);
}

if (!Array.isArray(routes) || routes.length === 0) {
  console.error("❌ No valid routes in RELAY_ROUTS variable");
  process.exit(1);
}

const lastMap = loadJson(STATE_FILE, {}); // { [sourceId]: lastId }

(async () => {
  try {
    for (const { source, target } of routes) {
      if (!source || !target) continue;

      console.log(`\n=== Route: ${source} -> ${target} ===`);
      const lastId = lastMap[source] || null;
      const options = lastId ? { after: lastId, limit: 100 } : { limit: 100 };
      console.log(`Fetching messages with options:`, options);

      // GET messages via REST (no Gateway)
      const fetched = await rest.get(Routes.channelMessages(source), { query: options });
      const sorted = [...fetched].sort(
        (a, b) => a.timestamp - b.timestamp // API returns ISO strings; but discord.js wraps as createdTimestamp. Here we use raw REST.
      );

      console.log(`Fetched ${sorted.length} new messages`);

      // Helper to send to target (webhook or channel ID)
      async function sendToTarget(payload) {
        if (typeof target === "string" && target.startsWith("https://discord.com/api/webhooks/")) {
          const webhook = new WebhookClient({ url: target });
          await webhook.send({ ...payload, allowed_mentions: { parse: [] } });
          await webhook.destroy?.();
        } else {
          await rest.post(Routes.channelMessages(String(target)), {
            body: { ...payload, allowed_mentions: { parse: [] } },
          });
        }
      }

      for (const msg of sorted) {
        const id = msg.id;
        if (!id) continue;

        const content = (msg.content || "").trim();
        const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

        if (!content && embeds.length === 0 && attachments.length === 0) {
          lastMap[source] = id;
          continue;
        }

        // Build payload:
        // - Keep content as-is
        // - Forward embeds (up to 10)
        // - Attachments: re-uploading would require fetching binaries; instead, append URLs to content
        let finalContent = content;
        if (attachments.length) {
          const urls = attachments
            .map((a) => a?.url)
            .filter(Boolean);
          if (urls.length) {
            finalContent = [finalContent, ...urls].filter(Boolean).join("\n");
          }
        }

        const payload = {
          ...(finalContent && { content: finalContent }),
          ...(embeds.length && { embeds: embeds.slice(0, 10) }),
        };

        console.log(`Relaying message ${id} -> ${target}`);
        await sendToTarget(payload);

        lastMap[source] = id;
        await sleep(200);
      }
    }

    console.log("\nSaving state...");
    saveJson(STATE_FILE, lastMap);
  } catch (err) {
    console.error("Relay error:", err);
  } finally {
    console.log("Done (no Gateway connection used).");
  }
})();
