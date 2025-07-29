// earnings/fetchEarnings.mjs
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import dayjs from "dayjs";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import "dotenv/config";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const EARNINGS_CHANNEL_ID = process.env.EARNINGS_CHANNEL_ID;
const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;

const STATE_FILE = path.resolve("./earnings/earnings-finnhub-state.json");
const sleep = ms => new Promise(res => setTimeout(res, ms));
const SLEEP_BETWEEN_SENDS = 3000;

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
  console.log(`State saved in ${Date.now() - t0} ms`);
}

async function main() {
  const state = await loadState();

  const today = dayjs().format("YYYY-MM-DD");
  const oneWeekAgo = dayjs().subtract(7, "day").format("YYYY-MM-DD");
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${oneWeekAgo}&to=${today}&token=${FINNHUB_TOKEN}`;

  const { data } = await axios.get(url);
  const unsorted_earnings = data.earningsCalendar || [];
  const earnings = unsorted_earnings.sort((a, b) => new Date(a.date) - new Date(b.date));

  const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
  await discordClient.login(DISCORD_TOKEN);
  const channel = await discordClient.channels.fetch(EARNINGS_CHANNEL_ID);

  for (const item of earnings) {
    const isReported = item.epsActual !== null || item.revenueActual !== null;
    if (!isReported) continue; // Skip if no actual EPS or revenue reported

    const exists = state.some(e => e.symbol === item.symbol && e.date === item.date);
    if (!exists) {
      const surprise = item.epsActual - item.epsEstimate;
      const statusEmoji = surprise > 0 ? "🟢" : surprise < 0 ? "🔴" : "🔵";

      const embed = new EmbedBuilder()
        .setColor(0x0000ff) // Blue for Finnhub earnings
        .setTitle(`${statusEmoji} ${item.symbol}`)
        .setURL(`https://finance.yahoo.com/quote/${item.symbol}`)
        .addFields(
          { name: "Earnings Date", value: item.date, inline: true },
          { name: "Report Hour", value: item.hour === "bmo" ? "Before Market Open" : item.hour === "amc" ? "After Market Close" : item.hour === "dmh" ? "During Market Hours" : "Unknown", inline: true},
          { name: "Quarter", value: String(item.quarter), inline: true },
          { name: "EPS", value: `${item.epsActual ?? "N/A"}`, inline: true },
          { name: "EPS Estimate", value: `${item.epsEstimate ?? "N/A"}`, inline: true },
          { name: "Revenue", value: `${item.revenueActual ? "$" + (item.revenueActual / 1e9).toFixed(2) + "B" : "N/A"}`, inline: true },
          { name: "Revenue Estimate", value: `${item.revenueEstimate ? "$" + (item.revenueEstimate / 1e9).toFixed(2) + "B" : "N/A"}`, inline: true }
        )
        .setFooter({ text: `Earnings Hub: https://earningshub.com/quote/${item.symbol}\nEarnings Whisper: https://www.earningswhispers.com/epsdetails/${item.symbol}\nYahoo Finance: https://finance.yahoo.com/quote/${item.symbol}` })
        .setAuthor({ name: "Source: Finnhub" })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      state.push({ symbol: item.symbol, date: item.date });
      console.log(`✔ Sent: ${item.symbol} (${item.date})`);
      await sleep(SLEEP_BETWEEN_SENDS);
    }
  }

  await saveState(state);
  console.log(`Total records: ${state.length}`);
  await discordClient.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
