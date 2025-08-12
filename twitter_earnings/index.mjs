import "dotenv/config";
import fs from "fs/promises";
import { WebhookClient } from "discord.js";
import { fetchLatestPosts } from "../x.com/fetchPosts.mjs";

const { DISCORD_TWITTER_EARNINGS_WEBHOOK, X_USERNAMES } = process.env;

if (!DISCORD_TWITTER_EARNINGS_WEBHOOK) {
  console.error("Missing env DISCORD_TWITTER_EARNINGS_WEBHOOK");
  process.exit(1);
}

const webhook = new WebhookClient({ url: DISCORD_TWITTER_EARNINGS_WEBHOOK });
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
    const users = X_USERNAMES.split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean);

    for (const username of users) {
      try {
        const stateFile = `./twitter_earnings/last_link_${username}.json`;
        const sent = await loadSent(stateFile);

        const links = await fetchLatestPosts(username, 50);
        console.log(`Fetched links for ${username}:`, links);

        // filter already-sent and dedupe
        let newLinks = links.filter((l) => !sent.includes(l));
        if (!newLinks.length) continue;
        newLinks = Array.from(new Set(newLinks));

        // send oldest first
        for (const link of newLinks.reverse()) {
          await webhook.send({ content: link, allowed_mentions: { parse: [] } });
          await sleep(1000); // gentle rate-limit cushion
        }

        await saveSent(stateFile, sent.concat(newLinks));
      } catch (err) {
        console.error(`Error processing user ${username}:`, err);
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
