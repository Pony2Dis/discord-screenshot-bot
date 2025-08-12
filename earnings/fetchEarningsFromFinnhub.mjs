// earnings/fetchEarnings.mjs
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import dayjs from "dayjs";
import { WebhookClient, EmbedBuilder } from "discord.js";
import "dotenv/config";

const DISCORD_EARNINGS_WEBHOOK = process.env.DISCORD_EARNINGS_WEBHOOK;
const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;

if (!DISCORD_EARNINGS_WEBHOOK) {
  console.error("❌ Missing DISCORD_EARNINGS_WEBHOOK");
  process.exit(1);
}
if (!FINNHUB_TOKEN) {
  console.error("❌ Missing FINNHUB_TOKEN");
  process.exit(1);
}

const STATE_FILE = path.resolve("./earnings/earnings-finnhub-state.json");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const SLEEP_BETWEEN_SENDS = 3000;
const webhook = new WebhookClient({ url: DISCORD_EARNINGS_WEBHOOK });

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

async function saveState(state) {
  console.log(`Saving state to ${STATE_FILE}…`);
  const t0 = Date.now();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`State saved in ${Date.now() - t0} ms`);
}

async function main() {
  const state = await loadState();

  const today = dayjs().format("YYYY-MM-DD");
  const oneWeekAgo = dayjs().subtract(7, "day").format("YYYY-MM-DD");
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${oneWeekAgo}&to=${today}&token=${FINNHUB_TOKEN}`;

  try {
    const { data } = await axios.get(url, { timeout: 30000 });
    const unsorted_earnings = data.earningsCalendar || [];
    const earnings = unsorted_earnings.sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    for (const item of earnings) {
      const isReported =
        item.epsActual !== null || item.revenueActual !== null;
      if (!isReported) continue;

      const exists = state.some(
        (e) => e.symbol === item.symbol && e.date === item.date
      );
      if (exists) continue;

      const surprise =
        item.epsActual != null && item.epsEstimate != null
          ? item.epsActual - item.epsEstimate
          : null;
      const statusEmoji =
        surprise == null ? "🔵" : surprise > 0 ? "🟢" : surprise < 0 ? "🔴" : "🔵";

      const toBillions = (n) =>
        n == null ? "N/A" : `$${(n / 1e9).toFixed(2)}B`;

      const embed = new EmbedBuilder()
        .setColor(0x0000ff)
        .setTitle(`${statusEmoji} ${item.symbol}`)
        .setURL(`https://finance.yahoo.com/quote/${item.symbol}`)
        .addFields(
          { name: "Earnings Date", value: String(item.date), inline: true },
          {
            name: "Report Hour",
            value:
              item.hour === "bmo"
                ? "Before Market Open"
                : item.hour === "amc"
                ? "After Market Close"
                : item.hour === "dmh"
                ? "During Market Hours"
                : "Unknown",
            inline: true,
          },
          { name: "Quarter", value: String(item.quarter ?? "N/A"), inline: true },
          { name: "EPS", value: String(item.epsActual ?? "N/A"), inline: true },
          { name: "EPS Estimate", value: String(item.epsEstimate ?? "N/A"), inline: true },
          { name: "Revenue", value: toBillions(item.revenueActual), inline: true },
          { name: "Revenue Estimate", value: toBillions(item.revenueEstimate), inline: true }
        )
        .setFooter({
          text:
            `Earnings Hub: https://earningshub.com/quote/${item.symbol}\n` +
            `Earnings Whispers: https://www.earningswhispers.com/epsdetails/${item.symbol}\n` +
            `Yahoo Finance: https://finance.yahoo.com/quote/${item.symbol}`,
        })
        .setAuthor({ name: "Source: Finnhub" })
        .setTimestamp();

      await webhook.send({
        embeds: [embed],
        allowed_mentions: { parse: [] },
      });

      state.push({ symbol: item.symbol, date: item.date });
      console.log(`✔ Sent: ${item.symbol} (${item.date})`);
      await sleep(SLEEP_BETWEEN_SENDS);
    }
  } catch (error) {
    console.error("❌ Error sending messages:", error);
  } finally {
    await saveState(state);
    console.log(`Total records: ${state.length}`);
    await webhook.destroy?.();
  }
}

main().catch(async (err) => {
  console.error(err);
  await webhook.destroy?.();
  process.exit(1);
});
