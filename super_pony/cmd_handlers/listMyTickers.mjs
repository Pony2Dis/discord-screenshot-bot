import fs from "fs/promises";

// format date (Asia/Jerusalem) -> YYYY-MM-DD
function formatIL(iso) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d); // e.g., 2025-08-09
  } catch {
    return iso?.slice(0, 10) || "";
  }
}

async function loadDb(dbPath) {
  try {
    const txt = await fs.readFile(dbPath, "utf-8");
    const json = JSON.parse(txt);
    if (Array.isArray(json)) return { entries: json };
    if (!json.entries) json.entries = [];
    return json;
  } catch {
    return { entries: [] };
  }
}

// Parse optional "since" date from the user's message text (YYYY-MM-DD anywhere)
function parseSinceFromMessage(message) {
  const m = message.content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!m) return null;
  const ts = Date.parse(m[1]); // treated as UTC midnight
  return Number.isFinite(ts) ? ts : null;
}

// send long text safely in chunks under Discord limit
async function sendChunked(channel, header, lines, maxLen = 1900) {
  let chunk = header ? header + "\n" : "";
  for (const line of lines) {
    if ((chunk + line + "\n").length > maxLen) {
      await channel.send(chunk.trimEnd());
      chunk = "";
    }
    chunk += line + "\n";
  }
  if (chunk.trim()) await channel.send(chunk.trimEnd());
}

/**
 * listMyTickers:
 * - Aggregates tickers mentioned by the requesting user
 * - Optional "since" date: detects YYYY-MM-DD in the message and filters from that date to today
 * - Sorted by count desc, then last mention desc
 * - Shows up to `limit` (default 50)
 */
export async function listMyTickers({
  message,
  dbPath,
  limit = 50,
} = {}) {
  const userId = message.author.id;
  const sinceTs = parseSinceFromMessage(message); // null or ms

  const db = await loadDb(dbPath);
  const all = db.entries || [];

  // filter by user and (optional) date range
  const mine = all.filter((e) => {
    if (!e?.user?.id || !e?.timestamp) return false;
    if (e.user.id !== userId) return false;
    if (sinceTs != null) {
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t) || t < sinceTs) return false;
    }
    return true;
  });

  if (mine.length === 0) {
    if (sinceTs != null) {
      const sinceStr = new Date(sinceTs).toISOString().slice(0, 10);
      await message.channel.send(`לא מצאתי טיקרים שלך מאז ${sinceStr}.`);
    } else {
      await message.channel.send("לא מצאתי טיקרים שלך בנתונים שנאספו.");
    }
    return;
  }

  // Aggregate per ticker
  const agg = new Map();
  for (const e of mine) {
    const key = e.ticker;
    const prev = agg.get(key) || { ticker: key, count: 0, lastTs: 0, lastIso: "", lastLink: "" };
    const ts = Date.parse(e.timestamp || 0) || 0;
    prev.count += 1;
    if (ts >= prev.lastTs) {
      prev.lastTs = ts;
      prev.lastIso = e.timestamp;
      prev.lastLink = e.link || prev.lastLink;
    }
    agg.set(key, prev);
  }

  const rows = Array.from(agg.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastTs - a.lastTs;
  });

  const totalUnique = rows.length;
  const shown = rows.slice(0, limit);

  const header =
    `**הטיקרים שלך**` +
    (sinceTs != null ? ` מאז ${new Date(sinceTs).toISOString().slice(0, 10)}` : "") +
    ` — ${totalUnique} ייחודיים (מוצגים ${shown.length}${shown.length < totalUnique ? ` מתוך ${totalUnique}` : ""})`;

  // Lines like: AAPL — 7 mentions (last: 2025-08-09)
  const lines = shown.map(
    (r) => `${r.ticker} — ${r.count} mentions (last: ${formatIL(r.lastIso)})`
  );

  await sendChunked(message.channel, header, lines);

  if (totalUnique > shown.length) {
    await message.channel.send("טיפ: אפשר להוסיף תאריך בפורמט YYYY-MM-DD או לבקש limit גבוה יותר.");
  }
}

export default { listMyTickers };
