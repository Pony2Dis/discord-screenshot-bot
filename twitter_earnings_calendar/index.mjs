import "dotenv/config";
import fs from "fs/promises";
import { WebhookClient } from "discord.js";
import {
  fetchFirstEarningsImage,
  fetchLatestImpliedMoveCard,
  closeBrowser
} from "../x.com/fetchImage.mjs";

const { DISCORD_TWITTER_EARNINGS_CAL_WEBHOOK, X_USERNAMES } = process.env;
if (!DISCORD_TWITTER_EARNINGS_CAL_WEBHOOK) {
  console.error("Missing env DISCORD_TWITTER_EARNINGS_CAL_WEBHOOK");
  process.exit(1);
}

const webhook = new WebhookClient({ url: DISCORD_TWITTER_EARNINGS_CAL_WEBHOOK });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const monthNames = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

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
    const users = (X_USERNAMES || "")
      .split(/\r?\n/)
      .map(u => u.trim())
      .filter(Boolean);

    for (const username of users) {
      const stateFile = `./twitter_earnings_calendar/last_link_${username}.json`;
      const sent = await loadSent(stateFile);

      // compute this week’s Monday
      const today = new Date();
      const diff = today.getDay() - 1;
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - diff);

      // previous, current, next
      for (const offset of [-1, 0, 1]) {
        const monday = new Date(thisMonday);
        monday.setDate(thisMonday.getDate() + offset * 7);
        let formatted = `${monthNames[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;
        const cal_date = `${monday.getDate().toString().padStart(2, '0')}.${(monday.getMonth() + 1).toString().padStart(2, '0')}.${monday.getFullYear()}`;
        formatted = `#earnings for the week of ${formatted}`;
        const tag = offset < 0 ? "previous" : offset > 0 ? "next" : "current";

        try {
          const { imageUrl, postUrl } = await fetchFirstEarningsImage(username, formatted);
          if (!postUrl || sent.includes(postUrl)) continue;

          console.log(`Fetched ${tag}-week link for ${username}:`, imageUrl, "at post:", postUrl);
          await webhook.send({
            content: `@everyone \nמדווחות בשבוע ${cal_date}:\n${imageUrl}`,
            allowed_mentions: { parse: [] }
          });

          await sleep(1000);
          sent.push(postUrl);
        } catch (err) {
          if (offset > 0) {
            console.warn(`⚠️ No post yet for future week (“${formatted}”), skipping.`);
            continue;
          }
          console.error(`❌ Error fetching ${tag}-week image for ${username}:`, err);
        }
      }

      await saveSent(stateFile, sent);
    }

    // ---- Latest green "Implied Move" board from somoscdi search
    const impliedStateFile = "./twitter_earnings_calendar/last_link_implied_move.json";
    const impliedSent = await loadSent(impliedStateFile);
    const searchUrl =
      "https://twitter.com/search?q=%28from%3Asomoscdi%29%20%22Implied%20Move%22%20%28Lunes%20OR%20Martes%20OR%20Mi%C3%A9rcoles%20OR%20Jueves%20OR%20Viernes%29%20filter%3Aimages&f=live";

    try {
      const { imageUrl, postUrl, postedAt } = await fetchLatestImpliedMoveCard(searchUrl);
      if (postUrl && !impliedSent.includes(postUrl)) {
        // Determine week label:
        // Sun/Mon -> current week; Tue–Sat -> next week.
        const baseDate = postedAt ? new Date(postedAt) : new Date();
        const d = new Date(baseDate);
        d.setHours(0, 0, 0, 0);
        const dow = d.getDay(); // 0..6
        const monday = new Date(d);
        if (dow === 0) monday.setDate(d.getDate() - 6);
        else if (dow >= 2) monday.setDate(d.getDate() + (8 - dow));
        const formatted = `${monthNames[monday.getMonth()]} ${monday.getDate()}, ${monday.getFullYear()}`;

        await webhook.send({
          content: `@everyone \n"Implied Move" לשבוע: ${formatted}\n${imageUrl}\n`,
          allowed_mentions: { parse: [] }
        });
        impliedSent.push(postUrl);
        await saveSent(impliedStateFile, impliedSent);
      } else {
        console.log("No new implied-move post to send.");
      }
    } catch (e) {
      console.warn("Skipping implied-move fetch:", e?.message || e);
    }

  } catch (err) {
    console.error("Error in main execution:", err);
  } finally {
    console.log("Finished processing all users.");
    await closeBrowser();
    await webhook.destroy?.();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeBrowser();
  await webhook.destroy?.();
  process.exit(1);
});
