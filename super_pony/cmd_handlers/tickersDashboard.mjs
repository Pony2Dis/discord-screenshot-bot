import fs from "fs/promises";
import axios from "axios";
import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

/** ---------- Helpers: DB + time ---------- */
async function loadDb(dbPath) {
  try {
    const raw = await fs.readFile(dbPath, "utf-8");
    const db = JSON.parse(raw || "{}");
    return Array.isArray(db) ? { entries: db } : db || { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function startOfMonthUTC(d = new Date()) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}
function isInMonth(tsMs, monthStartMs) {
  const d = new Date(tsMs);
  return d.getUTCFullYear() === new Date(monthStartMs).getUTCFullYear()
      && d.getUTCMonth() === new Date(monthStartMs).getUTCMonth();
}

function shortDate(isoOrMs) {
  const d = new Date(isoOrMs);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

/** ---------- Aggregate: month-to-date ---------- */
/** Build per-ticker summary for the current month. */
function buildMonthAgg(entries) {
  const monthStart = startOfMonthUTC();
  const mtd = entries.filter(e => isInMonth(Date.parse(e.timestamp), monthStart));

  // Map: sym -> { countMTD, firstTs, firstLink, firstUserId, firstUserName, lastTs, lastLink }
  const byTicker = new Map();
  for (const e of mtd) {
    const sym = e.ticker?.toUpperCase();
    if (!sym) continue;
    const ts = Date.parse(e.timestamp);
    const cur = byTicker.get(sym) || {
      countMTD: 0,
      firstTs: Infinity,
      firstLink: "",
      firstUserId: "",
      firstUserName: "",
      lastTs: -1,
      lastLink: "",
    };
    cur.countMTD++;
    if (ts < cur.firstTs) {
      cur.firstTs = ts;
      cur.firstLink = e.link || "";
      cur.firstUserId = e?.user?.id || "";
      cur.firstUserName = e?.user?.name || "";
    }
    if (ts > cur.lastTs) {
      cur.lastTs = ts;
      cur.lastLink = e.link || "";
    }
    byTicker.set(sym, cur);
  }

  // Count "first mentions" per user for this month
  const firstByUserCounts = new Map(); // userId -> {name, count}
  for (const [, v] of byTicker) {
    if (!v.firstUserId) continue;
    const e = firstByUserCounts.get(v.firstUserId) || { name: v.firstUserName || "", count: 0 };
    e.count++;
    if (!e.name && v.firstUserName) e.name = v.firstUserName;
    firstByUserCounts.set(v.firstUserId, e);
  }

  return { monthStart, byTicker, firstByUserCounts };
}

/** ---------- Pricing: Finnhub ---------- */
async function fetchDailyCandleCloseAtOrAfter(symbol, fromTsMs, token) {
  // Use daily candles from day-of-first-mention until now; take the first candle close >= that date
  // Finnhub expects seconds
  const from = Math.floor((fromTsMs - 24 * 3600 * 1000) / 1000); // pad back 1 day to be safe
  const to = Math.floor(Date.now() / 1000);
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(token)}`;
  const { data } = await axios.get(url);
  if (!data || data.s !== "ok" || !Array.isArray(data.t) || data.t.length === 0) {
    throw new Error(`No candles for ${symbol}`);
  }
  // Find first index whose candle time >= start-of-month day of mention
  for (let i = 0; i < data.t.length; i++) {
    const tMs = data.t[i] * 1000;
    if (tMs >= fromTsMs) {
      const c = data.c[i];
      if (c && c > 0) return c;
    }
  }
  // fallback to first candle close
  const c0 = data.c[0];
  if (c0 && c0 > 0) return c0;
  throw new Error(`Invalid candle data for ${symbol}`);
}

async function fetchLatestQuote(symbol, token) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
  const { data } = await axios.get(url);
  const px = data?.c || data?.pc || null;
  if (!px || px <= 0) throw new Error(`No quote for ${symbol}`);
  return px;
}

/** map with concurrency limit */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0, active = 0;
  return await new Promise((resolve) => {
    const next = () => {
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then((res) => { results[idx] = res; })
          .catch(() => { results[idx] = null; })
          .finally(() => {
            active--;
            if (i >= items.length && active === 0) resolve(results);
            else next();
          });
      }
    };
    next();
  });
}

/** Compute MTD gains for a set of tickers (based on their first-mention date this month). */
async function computeGainersMTD(symbolInfos, finnhubToken, { limitTickers = 50, concurrency = 3 } = {}) {
  const subset = symbolInfos.slice(0, limitTickers);
  const out = await mapLimit(subset, concurrency, async (info) => {
    try {
      const startClose = await fetchDailyCandleCloseAtOrAfter(info.symbol, info.firstTs, finnhubToken);
      const latest = await fetchLatestQuote(info.symbol, finnhubToken);
      const pct = ((latest - startClose) / startClose) * 100;
      return { ...info, startClose, latest, pct };
    } catch {
      return null;
    }
  });
  return out.filter(Boolean).sort((a, b) => b.pct - a.pct);
}

/** ---------- UI builders ---------- */
function buildDashboardComponents(userOptions, currentUserId) {
  // Buttons
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dash:hot5").setStyle(ButtonStyle.Primary).setLabel("Hot5"),
    new ButtonBuilder().setCustomId("dash:hot10").setStyle(ButtonStyle.Primary).setLabel("Hot10"),
    new ButtonBuilder().setCustomId(`dash:mine:${currentUserId}`).setStyle(ButtonStyle.Secondary).setLabel("Mine"),
    new ButtonBuilder().setCustomId("dash:all").setStyle(ButtonStyle.Secondary).setLabel("All"),
  );

  // Users select (first-mentioners this month)
  const menu = new StringSelectMenuBuilder()
    .setCustomId("dash:user")
    .setPlaceholder("Users")
    .addOptions(userOptions.slice(0, 25));
  const row2 = new ActionRowBuilder().addComponents(menu);

  return [row1, row2];
}

/** ---------- Public: show dashboard ---------- */
export async function showTickersDashboard({ message, dbPath, FINNHUB_TOKEN }) {
  const { entries } = await loadDb(dbPath);

  // Totals
  const allUnique = new Set(entries.map(e => (e.ticker || "").toUpperCase()).filter(Boolean)).size;

  // Month aggregates
  const { byTicker, firstByUserCounts } = buildMonthAgg(entries);
  const mtdItems = [...byTicker.entries()];
  const mtdUnique = mtdItems.length;

  // Top 10 MTD by mentions
  mtdItems.sort((a, b) => b[1].countMTD - a[1].countMTD || a[0].localeCompare(b[0]));
  const top10 = mtdItems.slice(0, 10).map(([s]) => s);

  // Top 3 Posters (by number of first-mentions this month)
  const posters = [...firstByUserCounts.entries()]
    .map(([id, v]) => ({ id, name: v.name || "Unknown", count: v.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(x => x.name);

  // Top Gainers (compute quickly on up to 25 symbols)
  const quickInfos = mtdItems.map(([sym, v]) => ({
    symbol: sym, firstTs: v.firstTs, firstUserName: v.firstUserName, firstLink: v.firstLink,
  }));
  let topGainersSyms = [];
  try {
    const gainers = await computeGainersMTD(quickInfos, FINNHUB_TOKEN, { limitTickers: 25, concurrency: 3 });
    topGainersSyms = gainers.slice(0, 3).map(g => g.symbol);
  } catch {
    topGainersSyms = [];
  }

  // Users dropdown options
  const userOptions = [...firstByUserCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[1].name || "").localeCompare(b[1].name || ""))
    .slice(0, 25)
    .map(([id, v]) => ({
      label: `${v.name || "Unknown"} (${v.count})`,
      value: id,
    }));

  // Embed
  const lines = [];
  lines.push(`Total Tracked: **${allUnique}** Tickers`);
  lines.push(`This month: **${mtdUnique}** Tickers`);
  if (top10.length) lines.push(`Top 10 Tickers: ${top10.map(s => `\`${s}\``).join(", ")}`);
  if (posters.length) lines.push(`Top 3 Posters: ${posters.join(", ")}`);
  if (topGainersSyms.length) lines.push(`Top Gainers: ${topGainersSyms.map(s => `\`${s}\``).join(", ")}`);

  const embed = new EmbedBuilder()
    .setColor(0x00b7ff)
    .setTitle("📈 Tickers — Dashboard (MTD)")
    .setDescription(lines.join("\n"));

  const components = buildDashboardComponents(userOptions, message.author.id);

  await message.channel.send({ embeds: [embed], components });
}

/** ---------- Public: handle button/select interactions ---------- */
export async function handleDashboardInteraction({ interaction, dbPath, FINNHUB_TOKEN }) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("dash:")) return false;

  const { entries } = await loadDb(dbPath);
  const { byTicker, firstByUserCounts } = buildMonthAgg(entries);
  const mtd = [...byTicker.entries()].sort((a, b) => b[1].countMTD - a[1].countMTD || a[0].localeCompare(b[0]));

  // Prepare info list for gainers calc
  const infos = mtd.map(([sym, v]) => ({
    symbol: sym,
    firstTs: v.firstTs,
    firstLink: v.firstLink,
    firstUserName: v.firstUserName,
  }));

  const sendPaged = async (title, lines) => {
    if (!lines.length) {
      await interaction.reply({ content: "—", ephemeral: true });
      return;
    }
    // chunk to ~1800 chars per msg
    let cur = "", chunks = [];
    for (const ln of lines) {
      if (cur.length + ln.length + 1 > 1800) { chunks.push(cur); cur = ""; }
      cur += ln + "\n";
    }
    if (cur) chunks.push(cur);

    await interaction.reply({ content: `**${title}**\n${chunks[0]}`, ephemeral: true });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
  };

  // 1) Hot5 / Hot10
  if (cid === "dash:hot5" || cid === "dash:hot10") {
    const topN = cid === "dash:hot5" ? 5 : 10;
    try {
      const ranked = await computeGainersMTD(infos, FINNHUB_TOKEN, { limitTickers: 200, concurrency: 4 });
      const picked = ranked.slice(0, topN);
      const lines = picked.map((r, i) => {
        const u = r.firstUserName ? r.firstUserName.toLowerCase() : "user";
        const pct = r.pct.toFixed(1).replace(/-0\.0/, "0.0");
        return `${i + 1}. \`${r.symbol}\`: **${pct}%** (MTD), [${u}](${r.firstLink || "#"})`;
      });
      await sendPaged(topN === 5 ? "🔥 Hot 5" : "🔥 Hot 10", lines);
    } catch (e) {
      await interaction.reply({ content: "לא הצלחתי לחשב תשואות כרגע.", ephemeral: true });
    }
    return true;
  }

  // 2) Mine
  if (cid.startsWith("dash:mine:")) {
    const uid = cid.split(":")[2] || interaction.user.id;
    const mine = mtd.filter(([, v]) => v.firstUserId === uid);
    if (!mine.length) {
      await interaction.reply({ content: "אין טיקרים שהוזכרו ראשונים על ידך החודש.", ephemeral: true });
      return true;
    }
    // compute gains for your first mentions
    const myInfos = mine.map(([sym, v]) => ({
      symbol: sym,
      firstTs: v.firstTs,
      firstLink: v.firstLink,
      firstUserName: v.firstUserName,
    }));
    try {
      const ranked = await computeGainersMTD(myInfos, FINNHUB_TOKEN, { limitTickers: 200, concurrency: 4 });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1).replace(/-0\.0/, "0.0");
        const u = r.firstUserName ? r.firstUserName.toLowerCase() : "you";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%** (MTD), [${u}](${r.firstLink || "#"})`;
      });
      await sendPaged("🎯 Mine (first mentions this month)", lines);
    } catch {
      await interaction.reply({ content: "תקלה בחישוב תשואות.", ephemeral: true });
    }
    return true;
  }

  // 3) All (list all tickers this month, previous embed format)
  if (cid === "dash:all") {
    const lines = mtd.map(([sym, v]) => {
      const firstUrl = v.firstLink || "#";
      const lastUrl = v.lastLink || "#";
      const lastStr = shortDate(v.lastTs);
      const who = v.firstUserName ? ` (${v.firstUserName})` : "";
      return `• [\`${sym}\`](${firstUrl}) — **${v.countMTD}**${who} — [${lastStr}](${lastUrl})`;
    });
    await sendPaged("📋 All (this month)", lines);
    return true;
  }

  // 4) Users dropdown (first mentions by selected user, then gains list)
  if (cid === "dash:user" && interaction.isStringSelectMenu()) {
    const targetId = interaction.values?.[0];
    if (!targetId) {
      await interaction.reply({ content: "לא נבחר משתמש.", ephemeral: true });
      return true;
    }
    const userFirst = mtd.filter(([, v]) => v.firstUserId === targetId);
    if (!userFirst.length) {
      await interaction.reply({ content: "אין טיקרים למשתמש זה החודש.", ephemeral: true });
      return true;
    }
    const infos2 = userFirst.map(([sym, v]) => ({
      symbol: sym,
      firstTs: v.firstTs,
      firstLink: v.firstLink,
      firstUserName: v.firstUserName,
    }));
    try {
      const ranked = await computeGainersMTD(infos2, FINNHUB_TOKEN, { limitTickers: 200, concurrency: 4 });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1).replace(/-0\.0/, "0.0");
        const u = r.firstUserName ? r.firstUserName.toLowerCase() : "user";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%** (MTD), [${u}](${r.firstLink || "#"})`;
      });
      await sendPaged("👤 User's first mentions (MTD)", lines);
    } catch {
      await interaction.reply({ content: "תקלה בחישוב תשואות.", ephemeral: true });
    }
    return true;
  }

  return false;
}
