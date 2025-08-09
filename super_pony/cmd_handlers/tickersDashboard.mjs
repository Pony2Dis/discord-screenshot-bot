import fs from "fs/promises";
import axios from "axios";
import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

/* ======================== DB + time helpers ======================== */
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
  const m0 = new Date(monthStartMs);
  return d.getUTCFullYear() === m0.getUTCFullYear() && d.getUTCMonth() === m0.getUTCMonth();
}
function shortDate(isoOrMs) {
  const d = new Date(isoOrMs);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

/* ======================== MTD aggregation ======================== */
function buildMonthAgg(entries) {
  const monthStart = startOfMonthUTC();
  const mtd = entries.filter((e) => isInMonth(Date.parse(e.timestamp), monthStart));

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

  const firstByUserCounts = new Map();
  for (const [, v] of byTicker) {
    if (!v.firstUserId) continue;
    const e = firstByUserCounts.get(v.firstUserId) || { name: v.firstUserName || "", count: 0 };
    e.count++;
    if (!e.name && v.firstUserName) e.name = v.firstUserName;
    firstByUserCounts.set(v.firstUserId, e);
  }
  return { byTicker, firstByUserCounts };
}

/* ======================== Yahoo Finance fetch ======================== */
const chartCache = new Map();

async function getYahooChart(symbol, fromTsMs) {
  const days = Math.max(1, Math.floor((Date.now() - fromTsMs) / 86400000));
  const range = days <= 30 ? "1mo" : days <= 62 ? "3mo" : days <= 370 ? "1y" : "5y";
  const key = `${symbol}|${range}`;
  if (chartCache.has(key)) return chartCache.get(key);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const { data } = await axios.get(url);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`yahoo chart NA for ${symbol}`);

  const ts = (r.timestamp || []).map((s) => s * 1000);
  const q = r.indicators?.quote?.[0] || {};
  const opens = q?.open || [];
  let closes = q?.close || [];
  if ((!closes || closes.length === 0) && r.indicators?.adjclose?.[0]?.adjclose) {
    closes = r.indicators.adjclose[0].adjclose;
  }
  const lastPrice =
    r.meta?.regularMarketPrice ?? [...closes].reverse().find((v) => v != null && isFinite(v));
  const tz = r.meta?.exchangeTimezoneName || "America/New_York";

  if (!Array.isArray(ts) || !Array.isArray(opens) || !Array.isArray(closes) || !lastPrice) {
    throw new Error(`yahoo parse fail for ${symbol}`);
  }
  const parsed = { timestamps: ts, opens, closes, lastPrice, tz };
  chartCache.set(key, parsed);
  return parsed;
}

function localYMD(ts, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ts)); // "YYYY-MM-DD"
}
function firstOfMonthYMDInTZ(tz, baseTs = Date.now()) {
  const ymd = localYMD(baseTs, tz); // e.g., "2025-08-09"
  const [y, m] = ymd.split("-");
  return `${y}-${m}-01`;
}

/**
 * Get start & latest.
 *  - startKind: "open" | "close"
 *  - endKind:   "last" | "close"
 *  - monthLocalFirst: if true, ignore fromTsMs date and anchor to the FIRST day-of-month
 *                     in the exchange's timezone (fixes UTC→previous-day issue).
 */
async function fetchStartAndLatest(
  symbol,
  fromTsMs,
  { startKind = "close", endKind = "last", monthLocalFirst = false } = {}
) {
  const ch = await getYahooChart(symbol, fromTsMs);
  const tz = ch.tz || "America/New_York";

  const targetYMD = monthLocalFirst ? firstOfMonthYMDInTZ(tz) : localYMD(fromTsMs, tz);

  // find candle with same local ymd; if none, first ymd > target
  let idx = -1;
  for (let i = 0; i < ch.timestamps.length; i++) {
    const ymd = localYMD(ch.timestamps[i], tz);
    if (ymd === targetYMD) {
      idx = i;
      break;
    }
    if (ymd > targetYMD && idx === -1) {
      idx = i;
      break;
    }
  }
  if (idx === -1) idx = 0;

  const series = startKind === "open" ? ch.opens : ch.closes;
  let start = series[idx];
  for (let j = idx; (start == null || !isFinite(start)) && j < series.length; j++) {
    if (series[j] != null && isFinite(series[j])) {
      start = series[j];
      break;
    }
  }

  let latest =
    endKind === "close"
      ? [...ch.closes].reverse().find((v) => v != null && isFinite(v))
      : ch.lastPrice;

  if (!(start > 0) || !(latest > 0)) throw new Error("bad prices for " + symbol);
  return { start, latest };
}

/* ======================== ranking ======================== */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0,
    active = 0;
  return await new Promise((resolve) => {
    const next = () => {
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then((res) => (results[idx] = res))
          .catch(() => (results[idx] = null))
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

/** rank by gain */
async function computeGainers(
  symbolInfos,
  {
    limitTickers = 50,
    concurrency = 3,
    basis = "mention", // "month" | "mention"
    startKind,         // override
    endKind = "last",
  } = {}
) {
  const subset = symbolInfos.slice(0, limitTickers);
  const monthStartTs = startOfMonthUTC();

  const out = await mapLimit(subset, concurrency, async (info) => {
    try {
      const startTs = basis === "month" ? monthStartTs : info.firstTs;
      const chosenStartKind = startKind ?? (basis === "month" ? "open" : "close");
      const { start, latest } = await fetchStartAndLatest(info.symbol, startTs, {
        startKind: chosenStartKind,
        endKind,
        monthLocalFirst: basis === "month", // <<— anchor to first day-of-month in exchange TZ
      });
      const pct = ((latest - start) / start) * 100;
      return { ...info, startPrice: start, latest, pct };
    } catch {
      return null;
    }
  });
  return out.filter(Boolean).sort((a, b) => b.pct - a.pct);
}

/* ======================== UI builders ======================== */
const METRIC_CHOICES = [
  { label: "Open→Close (Month)", value: "month_oc" },
  { label: "Open→Last (Since Mention)", value: "mention_oc" },
];

function buildDashboardComponents(userOptions, currentUserId, currentMetric = "month_oc") {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dash:hot5").setStyle(ButtonStyle.Primary).setLabel("Hot5"),
    new ButtonBuilder().setCustomId("dash:hot10").setStyle(ButtonStyle.Primary).setLabel("Hot10"),
    new ButtonBuilder().setCustomId(`dash:mine:${currentUserId}`).setStyle(ButtonStyle.Secondary).setLabel("Mine"),
    new ButtonBuilder().setCustomId("dash:all").setStyle(ButtonStyle.Secondary).setLabel("All"),
  );

  const usersMenu = new StringSelectMenuBuilder()
    .setCustomId("dash:user")
    .setPlaceholder("Users")
    .addOptions(userOptions.slice(0, 25));
  const row2 = new ActionRowBuilder().addComponents(usersMenu);

  const metricOptions = METRIC_CHOICES.map((c) => ({
    label: c.label,
    value: c.value,
    default: c.value === currentMetric,
  }));
  const metricMenu = new StringSelectMenuBuilder()
    .setCustomId("dash:metric")
    .setPlaceholder("Open→Close (Month)")
    .addOptions(metricOptions);
  const row3 = new ActionRowBuilder().addComponents(metricMenu);

  return [row1, row2, row3];
}
function getSelectedMetricFromMessage(msg) {
  const rows = msg?.components || [];
  for (const row of rows) {
    const comp = row.components?.[0];
    if (comp?.customId === "dash:metric") {
      const def = comp.options?.find?.((o) => o.default) || comp.options?.[0];
      return def?.value || "month_oc";
    }
  }
  return "month_oc";
}
function metricToComputeOpts(metric) {
  return metric === "mention_oc"
    ? { basis: "mention", startKind: "open" }
    : { basis: "month", startKind: "open" };
}

/* ======================== Public: dashboard ======================== */
export async function showTickersDashboard({ message, dbPath }) {
  const { entries } = await loadDb(dbPath);

  const allUnique = new Set(entries.map((e) => (e.ticker || "").toUpperCase()).filter(Boolean)).size;

  const { byTicker, firstByUserCounts } = buildMonthAgg(entries);
  const mtdItems = [...byTicker.entries()];
  const mtdUnique = mtdItems.length;

  const top10 = mtdItems
    .sort((a, b) => b[1].countMTD - a[1].countMTD || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([s]) => s);

  const posters = [...firstByUserCounts.entries()]
    .map(([id, v]) => ({ id, name: v.name || "Unknown", count: v.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((x) => x.name);

  // quick top gainers (Month: Open→Last) on up to 25 syms
  const quickInfos = mtdItems.map(([sym, v]) => ({
    symbol: sym,
    firstTs: v.firstTs,
    firstUserName: v.firstUserName,
    firstLink: v.firstLink,
  }));
  let topGainersSyms = [];
  try {
    const gainers = await computeGainers(quickInfos, {
      limitTickers: 25,
      concurrency: 3,
      basis: "month",
      startKind: "open",
    });
    topGainersSyms = gainers.slice(0, 3).map((g) => g.symbol);
  } catch {
    topGainersSyms = [];
  }

  const userOptions = [...firstByUserCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[1].name || "").localeCompare(b[1].name || ""))
    .slice(0, 25)
    .map(([id, v]) => ({ label: `${v.name || "Unknown"} (${v.count})`, value: id }));

  const lines = [];
  lines.push(`Total Tracked: **${allUnique}** Tickers`);
  lines.push(`This month: **${mtdUnique}** Tickers`);
  if (top10.length) lines.push(`Top 10 Tickers: ${top10.map((s) => `\`${s}\``).join(", ")}`);
  if (posters.length) lines.push(`Top 3 Posters: ${posters.join(", ")}`);
  if (topGainersSyms.length)
    lines.push(`Top Gainers: ${topGainersSyms.map((s) => `\`${s}\``).join(", ")}`);

  const embed = new EmbedBuilder()
    .setColor(0x00b7ff)
    .setTitle("📈 Tickers — Dashboard (MTD)")
    .setDescription(lines.join("\n"));

  const components = buildDashboardComponents(userOptions, message.author.id, "month_oc");
  await message.channel.send({ embeds: [embed], components });
}

/* ======================== Public: interactions ======================== */
export async function handleDashboardInteraction({ interaction, dbPath }) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("dash:")) return false;

  const { entries } = await loadDb(dbPath);
  const { byTicker } = buildMonthAgg(entries);
  const mtd = [...byTicker.entries()].sort(
    (a, b) => b[1].countMTD - a[1].countMTD || a[0].localeCompare(b[0])
  );

  const infos = mtd.map(([sym, v]) => ({
    symbol: sym,
    firstTs: v.firstTs,
    firstLink: v.firstLink,
    firstUserName: v.firstUserName,
    firstUserId: v.firstUserId,
    lastLink: v.lastLink,
    lastTs: v.lastTs,
    countMTD: v.countMTD,
  }));

  const sendPaged = async (title, lines) => {
    if (!lines.length) {
      await interaction.reply({ content: "—", ephemeral: true });
      return;
    }
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

  // metric selection → update defaults
  if (cid === "dash:metric" && interaction.isStringSelectMenu()) {
    const selected = interaction.values?.[0] || "month_oc";
    const rows = interaction.message.components.map((r) => ({
      type: r.type,
      components: r.components.map((c) => ({ ...c })),
    }));
    const metricRow = rows.find((r) => r.components?.[0]?.custom_id === "dash:metric");
    if (metricRow) {
      const menu = metricRow.components[0];
      menu.options = METRIC_CHOICES.map((m) => ({
        label: m.label,
        value: m.value,
        default: m.value === selected,
      }));
    }
    await interaction.update({ components: rows });
    return true;
  }

  // derive metric for all other actions
  const currentMetric = getSelectedMetricFromMessage(interaction.message);
  const computeOpts = metricToComputeOpts(currentMetric);

  // Hot5 / Hot10
  if (cid === "dash:hot5" || cid === "dash:hot10") {
    const topN = cid === "dash:hot5" ? 5 : 10;
    try {
      const ranked = await computeGainers(infos, {
        limitTickers: 200,
        concurrency: 4,
        ...computeOpts,
      });
      const picked = ranked.slice(0, topN);
      const lines = picked.map((r, i) => {
        const who = r.firstUserName || "user";
        const pct = r.pct.toFixed(1);
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${r.firstLink || "#"})`;
      });
      await sendPaged(topN === 5 ? "🔥 Hot 5" : "🔥 Hot 10", lines);
    } catch {
      await interaction.reply({ content: "לא הצלחתי לחשב תשואות כרגע.", ephemeral: true });
    }
    return true;
  }

  // Mine
  if (cid.startsWith("dash:mine:")) {
    const uid = cid.split(":")[2] || interaction.user.id;
    const mine = infos.filter((v) => v.firstUserId === uid);
    if (!mine.length) {
      await interaction.reply({
        content: "אין טיקרים שהוזכרו ראשונים על ידך החודש.",
        ephemeral: true,
      });
      return true;
    }
    try {
      const ranked = await computeGainers(mine, {
        limitTickers: 200,
        concurrency: 4,
        ...computeOpts,
      });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1);
        const who = r.firstUserName || "you";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${r.firstLink || "#"})`;
      });
      await sendPaged("🎯 Mine (first mentions this month)", lines);
    } catch {
      await interaction.reply({ content: "תקלה בחישוב תשואות.", ephemeral: true });
    }
    return true;
  }

  // All
  if (cid === "dash:all") {
    const lines = infos.map((v) => {
      const firstUrl = v.firstLink || "#";
      const lastUrl = v.lastLink || "#";
      const lastStr = shortDate(v.lastTs);
      const who = v.firstUserName ? ` (${v.firstUserName})` : "";
      return `• [\`${v.symbol}\`](${firstUrl}) — **${v.countMTD}**${who} — [${lastStr}](${lastUrl})`;
    });
    await sendPaged("📋 All (this month)", lines);
    return true;
  }

  // Users dropdown
  if (cid === "dash:user" && interaction.isStringSelectMenu()) {
    const targetId = interaction.values?.[0];
    if (!targetId) {
      await interaction.reply({ content: "לא נבחר משתמש.", ephemeral: true });
      return true;
    }
    const userFirst = infos.filter((v) => v.firstUserId === targetId);
    if (!userFirst.length) {
      await interaction.reply({ content: "אין טיקרים למשתמש זה החודש.", ephemeral: true });
      return true;
    }
    try {
      const ranked = await computeGainers(userFirst, {
        limitTickers: 200,
        concurrency: 4,
        ...computeOpts,
      });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1);
        const who = r.firstUserName || "user";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${r.firstLink || "#"})`;
      });
      await sendPaged("👤 User's first mentions (MTD)", lines);
    } catch {
      await interaction.reply({ content: "תקלה בחישוב תשואות.", ephemeral: true });
    }
    return true;
  }

  return false;
}
