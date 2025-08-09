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
  return (
    d.getUTCFullYear() === new Date(monthStartMs).getUTCFullYear() &&
    d.getUTCMonth() === new Date(monthStartMs).getUTCMonth()
  );
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
  const mtd = entries.filter((e) =>
    isInMonth(Date.parse(e.timestamp), monthStart)
  );

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
    const e = firstByUserCounts.get(v.firstUserId) || {
      name: v.firstUserName || "",
      count: 0,
    };
    e.count++;
    if (!e.name && v.firstUserName) e.name = v.firstUserName;
    firstByUserCounts.set(v.firstUserId, e);
  }

  return { byTicker, firstByUserCounts };
}

/* ======================== Yahoo Finance fetch (deterministic) ======================== */
// NOTE: We never use live price; always daily candles.
//       We also let caller pick startField ('open'|'close'|'adjclose') and endField ('close'|'adjclose').

async function getYahooChart(symbol, fromTsMs) {
  const days = Math.max(1, Math.floor((Date.now() - fromTsMs) / 86400000));
  const range =
    days <= 30 ? "1mo" : days <= 62 ? "3mo" : days <= 370 ? "1y" : "5y";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=${range}`;
  const { data } = await axios.get(url);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`yahoo chart NA for ${symbol}`);

  const timestamps = (r.timestamp || []).map((s) => s * 1000);
  const q = r.indicators?.quote?.[0] || {};
  const opens = q?.open || [];
  const closes = q?.close || [];
  const adjcloses = r.indicators?.adjclose?.[0]?.adjclose || [];
  const lastClose =
    [...closes].reverse().find((v) => v != null && isFinite(v)) ??
    [...adjcloses].reverse().find((v) => v != null && isFinite(v));
  const tz = r.meta?.exchangeTimezoneName || "America/New_York";

  if (!timestamps.length || (!closes.length && !adjcloses.length) || !lastClose)
    throw new Error(`yahoo parse fail for ${symbol}`);

  return { timestamps, opens, closes, adjcloses, lastClose, tz };
}

function localYMD(ts, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts)); // e.g. "2025-08-04"
}
function pickCandleIndexByLocalDate(timestamps, tz, targetTs) {
  const targetYMD = localYMD(targetTs, tz);
  let idx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    const ymd = localYMD(timestamps[i], tz);
    if (ymd === targetYMD) {
      idx = i;
      break;
    }
    if (ymd > targetYMD && idx === -1) {
      idx = i;
      break;
    }
  }
  return idx === -1 ? 0 : idx;
}
function seriesArray(chart, field) {
  if (field === "open") return chart.opens;
  if (field === "adjclose") return chart.adjcloses;
  return chart.closes; // "close"
}

async function fetchStartPrice(symbol, fromTsMs, startField /* 'open'|'close'|'adjclose' */) {
  const ch = await getYahooChart(symbol, fromTsMs);
  const arr = seriesArray(ch, startField);
  const i = pickCandleIndexByLocalDate(ch.timestamps, ch.tz, fromTsMs);
  let v = arr[i];
  for (let j = i; (v == null || !isFinite(v)) && j < arr.length; j++) v = arr[j];
  if (!(v > 0)) throw new Error("bad start price");
  return v;
}
async function fetchEndClose(symbol, fromTsMs, endField /* 'close'|'adjclose' */) {
  const ch = await getYahooChart(symbol, fromTsMs);
  const arr = seriesArray(ch, endField);
  const v = [...arr].reverse().find((x) => x != null && isFinite(x));
  if (!(v > 0)) throw new Error("bad end close");
  return v;
}

/* concurrency map */
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

/** rank by gain with configurable baseline/series
 *  basis: "mention" | "month"
 *  startField: "open" | "close" | "adjclose"
 *  endField: "close" | "adjclose"
 */
async function computeGainersMTD(
  symbolInfos,
  {
    limitTickers = 50,
    concurrency = 3,
    basis = "mention",
    startField = "open",
    endField = "close",
  } = {}
) {
  const subset = symbolInfos.slice(0, limitTickers);
  const monthStartTs = startOfMonthUTC();

  const out = await mapLimit(subset, concurrency, async (info) => {
    try {
      const startTs = basis === "month" ? monthStartTs : info.firstTs;
      const startPx = await fetchStartPrice(info.symbol, startTs, startField);
      const endPx = await fetchEndClose(info.symbol, startTs, endField);
      const pct = ((endPx - startPx) / startPx) * 100;
      return { ...info, startPx, endPx, pct };
    } catch {
      return null;
    }
  });
  return out.filter(Boolean).sort((a, b) => b.pct - a.pct);
}

/* ======================== UI builders ======================== */

// per-user mode (in-memory)
const userMode = new Map();
// defaults
const MODE_MONTH = { basis: "month", startField: "open", endField: "close" };
const MODE_MENTION = { basis: "mention", startField: "open", endField: "close" };

function buildDashboardComponents(userOptions, currentUserId, currentModeKey = "mtd_oc") {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dash:hot5").setStyle(ButtonStyle.Primary).setLabel("Hot5"),
    new ButtonBuilder().setCustomId("dash:hot10").setStyle(ButtonStyle.Primary).setLabel("Hot10"),
    new ButtonBuilder().setCustomId(`dash:mine:${currentUserId}`).setStyle(ButtonStyle.Secondary).setLabel("Mine"),
    new ButtonBuilder().setCustomId("dash:all").setStyle(ButtonStyle.Secondary).setLabel("All")
  );

  const usersMenu = new StringSelectMenuBuilder()
    .setCustomId("dash:user")
    .setPlaceholder("Users")
    .addOptions(userOptions.slice(0, 25));
  const row2 = new ActionRowBuilder().addComponents(usersMenu);

  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId("dash:mode")
    .setPlaceholder("Mode")
    .addOptions(
      {
        label: "Open→Close (Month)",
        value: "mtd_oc",
        description: "Baseline = month open",
        default: currentModeKey === "mtd_oc",
      },
      {
        label: "Open→Close (Since Mention)",
        value: "mention_oc",
        description: "Baseline = first mention",
        default: currentModeKey === "mention_oc",
      }
    );
  const row3 = new ActionRowBuilder().addComponents(modeMenu);

  return [row1, row2, row3];
}

/* ======================== Public: dashboard ======================== */
export async function showTickersDashboard({ message, dbPath }) {
  const { entries } = await loadDb(dbPath);

  const allUnique = new Set(
    entries.map((e) => (e.ticker || "").toUpperCase()).filter(Boolean)
  ).size;

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

  // quick preview line (Month baseline)
  const quickInfos = mtdItems.map(([sym, v]) => ({
    symbol: sym,
    firstTs: v.firstTs,
    firstUserName: v.firstUserName,
    firstLink: v.firstLink,
  }));
  let topGainersSyms = [];
  try {
    const gainers = await computeGainersMTD(quickInfos, {
      limitTickers: 25,
      concurrency: 3,
      basis: "month",
      startField: "open",
      endField: "close",
    });
    topGainersSyms = gainers.slice(0, 3).map((g) => g.symbol);
  } catch {
    topGainersSyms = [];
  }

  const userOptions = [...firstByUserCounts.entries()]
    .sort(
      (a, b) =>
        b[1].count - a[1].count ||
        (a[1].name || "").localeCompare(b[1].name || "")
    )
    .slice(0, 25)
    .map(([id, v]) => ({
      label: `${v.name || "Unknown"} (${v.count})`,
      value: id,
    }));

  // ensure default mode
  const uid = message.author.id;
  if (!userMode.has(uid)) userMode.set(uid, { key: "mtd_oc", cfg: MODE_MONTH });

  const lines = [];
  lines.push(`Total Tracked: **${allUnique}** Tickers`);
  lines.push(`This month: **${mtdUnique}** Tickers`);
  if (top10.length)
    lines.push(`Top 10 Tickers: ${top10.map((s) => `\`${s}\``).join(", ")}`);
  if (posters.length) lines.push(`Top 3 Posters: ${posters.join(", ")}`);
  if (topGainersSyms.length)
    lines.push(
      `Top Gainers: ${topGainersSyms.map((s) => `\`${s}\``).join(", ")}`
    );

  const embed = new EmbedBuilder()
    .setColor(0x00b7ff)
    .setTitle("📈 Tickers — Dashboard (MTD)")
    .setDescription(lines.join("\n"));

  const components = buildDashboardComponents(
    userOptions,
    uid,
    userMode.get(uid).key
  );
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
  }));

  const uid = interaction.user.id;
  if (!userMode.has(uid)) userMode.set(uid, { key: "mtd_oc", cfg: MODE_MONTH });
  const { cfg } = userMode.get(uid);

  const sendPaged = async (title, lines) => {
    if (!lines.length) {
      await interaction.reply({ content: "—", ephemeral: true });
      return;
    }
    let cur = "",
      chunks = [];
    for (const ln of lines) {
      if (cur.length + ln.length + 1 > 1800) {
        chunks.push(cur);
        cur = "";
      }
      cur += ln + "\n";
    }
    if (cur) chunks.push(cur);
    await interaction.reply({
      content: `**${title}**\n${chunks[0]}`,
      ephemeral: true,
    });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
  };

  // Mode selector
  if (cid === "dash:mode" && interaction.isStringSelectMenu()) {
    const val = interaction.values?.[0];
    if (val === "mtd_oc") userMode.set(uid, { key: "mtd_oc", cfg: MODE_MONTH });
    else if (val === "mention_oc")
      userMode.set(uid, { key: "mention_oc", cfg: MODE_MENTION });
    await interaction.reply({
      content:
        val === "mtd_oc"
          ? "Mode set to **Open→Close (Month)**."
          : "Mode set to **Open→Close (Since Mention)**.",
      ephemeral: true,
    });
    return true;
  }

  // Hot5 / Hot10
  if (cid === "dash:hot5" || cid === "dash:hot10") {
    const topN = cid === "dash:hot5" ? 5 : 10;
    try {
      const ranked = await computeGainersMTD(infos, {
        limitTickers: 200,
        concurrency: 4,
        basis: cfg.basis,
        startField: cfg.startField,
        endField: cfg.endField,
      });
      const picked = ranked.slice(0, topN);
      const lines = picked.map((r, i) => {
        const who = r.firstUserName ? r.firstUserName : "user";
        const pct = r.pct.toFixed(1);
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${
          r.firstLink || "#"
        })`;
      });
      await sendPaged(topN === 5 ? "🔥 Hot 5" : "🔥 Hot 10", lines);
    } catch {
      await interaction.reply({
        content: "לא הצלחתי לחשב תשואות כרגע.",
        ephemeral: true,
      });
    }
    return true;
  }

  // Mine
  if (cid.startsWith("dash:mine:")) {
    const mineUserId = cid.split(":")[2] || uid;
    const mine = mtd.filter(([, v]) => v.firstUserId === mineUserId);
    if (!mine.length) {
      await interaction.reply({
        content: "אין טיקרים שהוזכרו ראשונים על ידך החודש.",
        ephemeral: true,
      });
      return true;
    }
    const mineInfos = mine.map(([sym, v]) => ({
      symbol: sym,
      firstTs: v.firstTs,
      firstLink: v.firstLink,
      firstUserName: v.firstUserName,
    }));
    try {
      const ranked = await computeGainersMTD(mineInfos, {
        limitTickers: 200,
        concurrency: 4,
        basis: cfg.basis,
        startField: cfg.startField,
        endField: cfg.endField,
      });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1);
        const who = r.firstUserName || "you";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${
          r.firstLink || "#"
        })`;
      });
      await sendPaged("🎯 Mine (first mentions)", lines);
    } catch {
      await interaction.reply({
        content: "תקלה בחישוב תשואות.",
        ephemeral: true,
      });
    }
    return true;
  }

  // All (not affected by mode)
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

  // Users dropdown (respects mode)
  if (cid === "dash:user" && interaction.isStringSelectMenu()) {
    const targetId = interaction.values?.[0];
    if (!targetId) {
      await interaction.reply({ content: "לא נבחר משתמש.", ephemeral: true });
      return true;
    }
    const userFirst = mtd.filter(([, v]) => v.firstUserId === targetId);
    if (!userFirst.length) {
      await interaction.reply({
        content: "אין טיקרים למשתמש זה החודש.",
        ephemeral: true,
      });
      return true;
    }
    const infos2 = userFirst.map(([sym, v]) => ({
      symbol: sym,
      firstTs: v.firstTs,
      firstLink: v.firstLink,
      firstUserName: v.firstUserName,
    }));
    try {
      const ranked = await computeGainersMTD(infos2, {
        limitTickers: 200,
        concurrency: 4,
        basis: cfg.basis,
        startField: cfg.startField,
        endField: cfg.endField,
      });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1);
        const who = r.firstUserName || "user";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${
          r.firstLink || "#"
        })`;
      });
      await sendPaged("👤 User's first mentions", lines);
    } catch {
      await interaction.reply({
        content: "תקלה בחישוב תשואות.",
        ephemeral: true,
      });
    }
    return true;
  }

  return false;
}
