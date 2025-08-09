// super_pony/cmd_handlers/listMyTickers.mjs
import fs from "fs/promises";
import { EmbedBuilder } from "discord.js";

function unixFromIso(iso) {
  if (!iso) return null;
  const t = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(t) ? t : null;
}

function makePages(rows, { title, totals }) {
  const maxDesc = 3500;
  const pages = [];
  let buf = [];
  let size = 0;
  for (const line of rows) {
    if (size + line.length + 1 > maxDesc) {
      pages.push(buf.join("\n"));
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length) pages.push(buf.join("\n"));

  return pages.map((desc, i) =>
    new EmbedBuilder()
      .setColor(0x5865f2) // blurple
      .setTitle(title)
      .setDescription(desc)
      .setFooter({ text: `עמוד ${i + 1}/${pages.length} — ${totals.unique} ייחודיים, ${totals.total} אזכורים` })
  );
}

/**
 * listMyTickers:
 * - supports optional "fromDate" (inclusive) in format YYYY-MM-DD (already parsed before call if you like)
 *   You can pass `fromDateIso` or leave undefined.
 */
export async function listMyTickers({ message, dbPath, fromDateIso }) {
  const raw = await fs.readFile(dbPath, "utf-8").catch(() => "{}");
  const db = JSON.parse(raw || "{}");
  const entries = Array.isArray(db) ? db : db.entries || [];

  const userId = message.author.id;
  const fromTs = fromDateIso ? new Date(fromDateIso).getTime() : null;

  // filter to user (and date if provided)
  const mine = entries.filter((e) => {
    if (!e?.user?.id || e.user.id !== userId) return false;
    if (fromTs && new Date(e.timestamp).getTime() < fromTs) return false;
    return true;
  });

  // aggregate per ticker
  const map = new Map();
  for (const e of mine) {
    const key = e.ticker?.toUpperCase();
    if (!key) continue;
    const m = map.get(key) || { count: 0, last: null };
    m.count++;
    if (!m.last || new Date(e.timestamp) > new Date(m.last)) m.last = e.timestamp;
    map.set(key, m);
  }

  const items = [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  const total = mine.length;
  const unique = items.length;

  // rows
  const rows = items.map(([sym, { count, last }]) => {
    const ts = unixFromIso(last);
    const lastStr = ts ? `<t:${ts}:d>` : "—";
    return `• \`${sym}\` — **${count}** (last: ${lastStr})`;
  });

  const title = fromDateIso
    ? `🎯 הטיקרים שלך (מ־${fromDateIso} ועד היום)`
    : "🎯 הטיקרים שלך";

  const embeds = makePages(rows, {
    title,
    totals: { unique, total },
  });

  if (embeds.length === 0) {
    await message.channel.send("לא נמצאו טיקרים שלך.");
    return;
  }
  for (const emb of embeds) await message.channel.send({ embeds: [emb] });
}
