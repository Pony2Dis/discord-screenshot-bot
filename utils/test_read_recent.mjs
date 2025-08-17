import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ----- config -----
const LOG_DIR = process.env.SUPERPONY_LOG_DIR || "./data/logs";

// ----- helpers -----
function getDailyLogPath(channelId, date) {
  const yyyy_mm_dd = date.toISOString().split("T")[0];
  return path.join(LOG_DIR, `${channelId}_${yyyy_mm_dd}.jsonl`);
}

function parseArgs(argv) {
  const args = { sinceMinutes: 60, maxLines: 4000, raw: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a === "--channel") args.channel = argv[++i];
    else if (a === "--minutes") args.sinceMinutes = Number(argv[++i] || 60);
    else if (a === "--max") args.maxLines = Number(argv[++i] || 4000);
    else if (a === "--raw") args.raw = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

// Robust JSONL reader: tolerates BOM, CRLF, empty/malformed lines
async function readJsonlFile(filePath, { sinceMinutes = 60, maxLines = 4000 } = {}) {
  const cutoff = Date.now() - sinceMinutes * 60 * 1000;

  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    console.error("⚠️ Could not read file:", filePath, e.message || e);
    return [];
  }

  // Remove UTF-8 BOM if present; split on both \n and \r\n
  raw = raw.replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const items = [];
  // Only parse the most recent lines (cap)
  const start = Math.max(0, lines.length - maxLines);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    try {
      const o = JSON.parse(line);
      const t = new Date(o.createdAt).getTime();
      if (Number.isFinite(t) && t >= cutoff) items.push(o);
    } catch {
      // skip malformed lines silently
    }
  }

  // Sort ascending by time
  items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return items;
}

async function readTodayAndYesterday(channelId, sinceMinutes, maxLines) {
  const now = new Date();
  const todayPath = getDailyLogPath(channelId, now);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const yPath = getDailyLogPath(channelId, y);

  const [today, yest] = await Promise.all([
    readJsonlFile(todayPath, { sinceMinutes, maxLines }),
    readJsonlFile(yPath, { sinceMinutes, maxLines }),
  ]);

  const merged = [...yest, ...today];
  // ensure final cap (oldest dropped first)
  return merged.slice(-maxLines);
}

// ----- main -----
async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.file && !args.channel)) {
    console.log(
`Usage:
  node test_read_recent.mjs --file "<path-to-jsonl>" [--minutes 60] [--max 4000] [--raw]
  node test_read_recent.mjs --channel <channelId> [--minutes 60] [--max 4000] [--raw]

Examples:
  node test_read_recent.mjs --file "./data/logs/1397974488020156471_2025-08-17.jsonl" --minutes 180
  node test_read_recent.mjs --channel 1397974488020156471 --minutes 120
`
    );
    process.exit(0);
  }

  let records = [];
  if (args.file) {
    records = await readJsonlFile(args.file, {
      sinceMinutes: args.sinceMinutes,
      maxLines: args.maxLines,
    });
  } else {
    records = await readTodayAndYesterday(
      args.channel,
      args.sinceMinutes,
      args.maxLines,
    );
  }

  if (args.raw) {
    // Print as compact JSON array for easy piping/inspection
    console.log(JSON.stringify(records));
    return;
  }

  // Pretty print for humans
  console.log(`✅ Extracted ${records.length} record(s) from ${args.file ? args.file : `channel ${args.channel} (today+yesterday)`} in last ${args.sinceMinutes} min\n`);
  for (const r of records) {
    const ts = new Date(r.createdAt).toLocaleString();
    const contentOneLine = (r.content || "").replace(/\s+/g, " ").trim();
    console.log(`• ${ts} | ${r.author} | ${contentOneLine}`);
    if (r.refMsgLink) console.log(`  ↳ reply-to: ${r.refMsgLink}`);
    if (r.msgLink) console.log(`  ↳ link: ${r.msgLink}`);
    if (r.attachments?.length) {
      for (const a of r.attachments) {
        console.log(`  📎 ${a.name || "attachment"}: ${a.url}`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("Unhandled error:", e?.stack || e?.message || e);
    process.exit(1);
  });
}
