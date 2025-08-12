// index.mjs (webhook-based)

import "dotenv/config";
import fs from "fs/promises";
import { WebhookClient } from "discord.js";
import { fetchLatestPosts } from "../x.com/fetchPosts.mjs";

const { DISCORD_TWITTER_INFLUENCERS_WEBHOOK, X_USERNAMES } = process.env;
if (!DISCORD_TWITTER_INFLUENCERS_WEBHOOK) {
  console.error("Missing env DISCORD_TWITTER_INFLUENCERS_WEBHOOK");
  process.exit(1);
}

const webhook = new WebhookClient({ url: DISCORD_TWITTER_INFLUENCERS_WEBHOOK });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function loadSent(file) {
  try {
    const txt = await fs.readFile(file, "utf-8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function saveSent(file, sent) {
  await fs.writeFile(file, JSON.stringify(sent, null, 2), "utf-8");
}

async function main() {
  try {
    const users = X_USERNAMES
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean);

    for (const username of users) {
      try {
        const stateFile = `./twitter_influencers/last_link_${username}.json`;
        const sent = await loadSent(stateFile);
        const links = await fetchLatestPosts(username, 10);
        console.log(`Fetched links for ${username}:`, links);

        // --- URL normalization to avoid duplicates ---
        const normalizeUrl = (url) => {
          try {
            const u = new URL(url);
            return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
          } catch {
            return url.replace(/\?.*$/, "").replace(/\/$/, "");
          }
        };

        const normalizedSent = sent.map(normalizeUrl);

        let newLinks = links.filter((link) => {
          const n = normalizeUrl(link);
          const isNew = !normalizedSent.includes(n);
          if (isNew) {
            console.log(`New link found for ${username}:`, n, "sent:", normalizedSent);
          }
          return isNew;
        });

        if (!newLinks.length) continue;

        // de-dup and send oldest first
        newLinks = Array.from(new Set(newLinks)).reverse();

        for (const link of newLinks) {
          await webhook.send({ content: link, allowed_mentions: { parse: [] } });
          await sleep(1000);
        }

        // Save only normalized URLs
        const updatedSent = Array.from(
          new Set([...normalizedSent, ...newLinks.map(normalizeUrl)])
        );
        await saveSent(stateFile, updatedSent);
      } catch (error) {
        console.error(`Error processing user ${username}:`, error);
      }
    }
  } catch (error) {
    console.error("Error in main execution:", error);
  } finally {
    console.log("Finished processing all users.");
    await webhook.destroy?.();
  }
}

main().catch(async (err) => {
  console.error(err);
  await webhook.destroy?.();
  process.exit(1);
});
