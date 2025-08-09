// super_pony/cmd_handlers/listAllTickers.mjs
import fs from "fs/promises";
import { EmbedBuilder } from "discord.js";

function unixFromIso(iso) {
  if (!iso) return null;
  const t = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(t) ? t : null;
}

function makePages(rows, { title, totals }) {
  // rows are already strings; pack them into multiple embeds within safe size
  const maxDesc = 3500; // keep well under embed limits
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
      .setColor(0x57f287) // green
      .setTitle(title)
      .setDescription(desc)
      .setFooter({ text: `עמוד ${i + 1}/${pages.length} — סה"כ ${totals.unique} ייחודיים, ${totals.total} אזכורים` })
  );
}

export async function listAllTickers({ message, dbPath, includeCounts = true, minMentions = 1 }) {
  const raw = await fs.readFile(dbPath, "utf-8").catch(() => "{}");
  const db = JSON.parse(raw || "{}");
  const entries = Array.isArray(db) ? db : db.entries || [];

  // aggregate
  const map = new Map(); // symbol -> { count, last }
  for (const e of entries) {
    const key = e.ticker?.toUpperCase();
    if (!key) continue;
    const m = map.get(key) || { count: 0, last: null };
    m.count++;
    if (!m.last || new Date(e.timestamp) > new Date(m.last)) m.last = e.timestamp;
    map.set(key, m);
  }

  // filter, sort
  const items = [...map.entries()]
    .filter(([, v]) => v.count >= minMentions)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  const totalMentions = entries.length;
  const unique = items.length;

  // render rows
  const rows = items.map(([sym, { count, last }]) => {
    const ts = unixFromIso(last);
    const lastStr = ts ? `<t:${ts}:d>` : "—";
    return `• \`${sym}\` — **${count}** (last: ${lastStr})`;
  });

  const embeds = makePages(rows, {
    title: "📊 טיקרים במעקב",
    totals: { unique, total: totalMentions },
  });

  if (embeds.length === 0) {
    await message.channel.send("לא נמצאו טיקרים.");
    return;
  }
  for (const emb of embeds) await message.channel.send({ embeds: [emb] });
}
