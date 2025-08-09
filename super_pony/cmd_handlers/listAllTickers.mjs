import fs from "fs/promises";

/**
 * List all tickers we have in the DB, optionally with counts.
 *
 * Options:
 * - dbPath (string)             : absolute/relative path to db.json
 * - includeCounts (boolean)     : show counts per ticker (default: true)
 * - minMentions (number)        : filter out tickers with < minMentions (default: 1)
 * - maxToShow (number|0)        : 0 = show all, else limit after sorting (default: 0)
 * - sortBy ("mentions"|"alpha") : default "mentions" (desc). "alpha" sorts A->Z.
 */
export async function listAllTickers({
  message,
  dbPath,
  includeCounts = true,
  minMentions = 1,
  maxToShow = 0,
  sortBy = "mentions",
} = {}) {
  let db;
  try {
    const txt = await fs.readFile(dbPath, "utf-8");
    db = JSON.parse(txt);
  } catch {
    await message.channel.send("לא נמצא מסד נתונים. עדיין אין נתונים לשיתוף.");
    return;
  }

  const entries = Array.isArray(db) ? db : (db.entries || []);
  if (!entries.length) {
    await message.channel.send("אין עדיין טיקרים שנאספו.");
    return;
  }

  // Aggregate counts
  const counts = new Map(); // ticker -> count
  for (const e of entries) {
    const t = (e.ticker || "").toUpperCase();
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  // Filter by minMentions
  let rows = Array.from(counts.entries())
    .filter(([t, c]) => c >= minMentions);

  if (rows.length === 0) {
    await message.channel.send("אין טיקרים שעוברים את סף המינימום שביקשת.");
    return;
  }

  // Sort
  if (sortBy === "alpha") {
    rows.sort((a, b) => a[0].localeCompare(b[0]));
  } else {
    // mentions desc, then alpha
    rows.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  }

  if (maxToShow > 0) {
    rows = rows.slice(0, maxToShow);
  }

  const uniqueCount = rows.length;
  const totalMentions = entries.length;

  const header = `**טיקרים במעקב (סה"כ ${uniqueCount} ייחודיים, ${totalMentions} אזכורים):**\n`;
  const parts = rows.map(([t, c]) => includeCounts ? `${t} (${c})` : t);

  // Discord message limit ~2000 chars — chunk safely
  const MAX = 1900;
  let chunk = header;
  for (const p of parts) {
    const next = (chunk ? `${chunk}` : "") + (chunk === header ? "" : ", ") + p;
    if (next.length > MAX) {
      await message.channel.send(chunk);
      chunk = p; // start a fresh line without header
    } else {
      chunk = next;
    }
  }
  if (chunk) {
    await message.channel.send(chunk);
  }
}

export default listAllTickers;
