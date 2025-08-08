import fs from "fs/promises";
import fssync from "fs";
import path from "path";

/** Cache the tickers set in-memory to avoid rereads */
let _tickerSet = null;
let _tickerFilePath = null;

/** Simple write queue to serialize db.json writes */
let writeQueue = Promise.resolve();

/** Ensure directory exists for a file path */
async function ensureDirFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/** Load tickers (one per line) into an uppercase Set */
async function loadTickerSet(allTickersFile) {
  if (_tickerSet && _tickerFilePath === allTickersFile) return _tickerSet;
  if (!fssync.existsSync(allTickersFile)) {
    throw new Error(`Missing tickers file: ${allTickersFile}`);
  }
  const txt = await fs.readFile(allTickersFile, "utf-8");
  _tickerSet = new Set(
    txt
      .split(/\r?\n/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
  _tickerFilePath = allTickersFile;
  return _tickerSet;
}

/** Extract possible tickers and validate against the Set */
function extractTickers(text, tickerSet) {
  if (!text) return [];
  const found = new Set();
  // Supports TSLA / $TSLA / BRK.B / RIO
  const re = /(?:^|[^A-Za-z0-9])\$?([A-Za-z]{1,5}(?:\.[A-Za-z]{1,2})?)(?=$|[^A-Za-z0-9])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const cand = m[1].toUpperCase();
    if (tickerSet.has(cand)) found.add(cand);
  }
  return [...found];
}

/** Load db.json; normalize shape */
async function loadDb(dbPath) {
  try {
    const txt = await fs.readFile(dbPath, "utf-8");
    const json = JSON.parse(txt);
    if (Array.isArray(json)) {
      // old shape -> upgrade
      return { updated: new Date().toISOString(), entries: json };
    }
    if (!json.entries) json.entries = [];
    return json;
  } catch {
    return { updated: new Date().toISOString(), entries: [] };
  }
}

/** Append entry with dedupe by (messageId,ticker) */
async function appendEntry(dbPath, entry) {
  await ensureDirFor(dbPath);
  writeQueue = writeQueue.then(async () => {
    const db = await loadDb(dbPath);
    const exists = db.entries.some(
      (e) => e.messageId === entry.messageId && e.ticker === entry.ticker
    );
    if (exists) return;
    db.entries.push(entry);
    db.updated = new Date().toISOString();
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf-8");
  });
  return writeQueue;
}

/**
 * Handle a single message in GRAPHS_CHANNEL_ID:
 * - Skip if content missing
 * - Extract tickers, validate via all_tickers.txt
 * - Save rows into scanner/db.json
 * - Echo "logged ticker: ${ticker} from user: ${from_user}"
 */
export async function handleGraphChannelMessage({
  message,
  allTickersFile = "./scanner/all_tickers.txt",
  dbPath = "./scanner/db.json",
}) {
  const content = message.content?.trim();
  if (!content) return;

  const tickerSet = await loadTickerSet(allTickersFile);
  const tickers = extractTickers(content, tickerSet);
  if (tickers.length === 0) return;

  const displayName =
    message.member?.nickname ||
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username;

  for (const ticker of tickers) {
    const entry = {
      ticker,
      user: { id: message.author.id, name: displayName },
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guildId,
      link: message.url,
      timestamp: new Date(message.createdTimestamp).toISOString(),
      content, // optional: keep raw text for later analysis
    };

    await appendEntry(dbPath, entry);
    await message.channel.send(`logged ticker: ${ticker} from user: ${displayName}`);
  }
}
