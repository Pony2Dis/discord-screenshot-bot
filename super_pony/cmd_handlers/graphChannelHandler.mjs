import fs from "fs/promises";
import fssync from "fs";
import path from "path";

/** ---- config ---- */
const DISCORD_EPOCH = 1420070400000n; // 2015-01-01

/** Cache the tickers set in-memory to avoid rereads */
let _tickerSet = null;
let _tickerFilePath = null;

/** Simple write queue to serialize db.json writes */
let writeQueue = Promise.resolve();

/** Pre-compiled regex: TSLA / $TSLA / BRK.B / BRK-B */
const TICKER_RE =
  /(?:^|[^A-Za-z0-9])\$?([A-Za-z]{1,5}(?:[.\-][A-Za-z]{1,2})?)(?=$|[^A-Za-z0-9])/g;

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
  TICKER_RE.lastIndex = 0;
  let m;
  while ((m = TICKER_RE.exec(text)) !== null) {
    const cand = m[1].toUpperCase();
    const norm = cand.replace(/-/g, "."); // BRK-B -> BRK.B
    if (tickerSet.has(norm)) found.add(norm);
  }
  return [...found];
}

/** DB helpers */
async function loadDb(dbPath) {
  try {
    const txt = await fs.readFile(dbPath, "utf-8");
    const json = JSON.parse(txt);
    if (Array.isArray(json)) return { updated: new Date().toISOString(), entries: json, checkpoints: {} };
    if (!json.entries) json.entries = [];
    if (!json.checkpoints) json.checkpoints = {};
    return json;
  } catch {
    return { updated: new Date().toISOString(), entries: [], checkpoints: {} };
  }
}
async function saveDb(dbPath, db) {
  await ensureDirFor(dbPath);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf-8");
}

/** Compare two snowflake strings (by BigInt) */
function snowflakeGt(a, b) {
  if (!b) return true;
  return BigInt(a) > BigInt(b);
}

/** Convert timestamp (ms) -> synthetic snowflake string */
function snowflakeFromTsMs(ts) {
  const n = (BigInt(ts) - DISCORD_EPOCH) << 22n; // worker=0, process=0, inc=0
  return n.toString();
}

/** Update checkpoint for a channel (only if id is newer) */
async function updateCheckpoint(dbPath, channelId, msgId, tsIso) {
  writeQueue = writeQueue.then(async () => {
    const db = await loadDb(dbPath);
    const cp = db.checkpoints[channelId] || {};
    if (!cp.lastProcessedId || snowflakeGt(msgId, cp.lastProcessedId)) {
      db.checkpoints[channelId] = {
        lastProcessedId: msgId,
        lastProcessedAt: tsIso,
      };
      db.updated = new Date().toISOString();
      await saveDb(dbPath, db);
    }
  });
  return writeQueue;
}

/** Append multiple entries in a single read/write; dedupe by (messageId,ticker) */
async function appendEntries(dbPath, entries) {
  if (!entries.length) return;
  await ensureDirFor(dbPath);
  writeQueue = writeQueue.then(async () => {
    const db = await loadDb(dbPath);
    const have = new Set(db.entries.map((e) => `${e.messageId}:${e.ticker}`));
    let added = 0;
    for (const entry of entries) {
      const key = `${entry.messageId}:${entry.ticker}`;
      if (have.has(key)) continue;
      db.entries.push(entry);
      have.add(key);
      added++;
    }
    if (added > 0) {
      db.updated = new Date().toISOString();
      await saveDb(dbPath, db);
    }
  });
  return writeQueue;
}

/**
 * Handle a single message in GRAPHS_CHANNEL_ID:
 * - Skip if content missing
 * - Extract tickers, validate via all_tickers.txt (supports '.' or '-' class)
 * - Save rows into scanner/db.json (single write per message)
 * - Echo "logged ticker: ${ticker} from user: ${from_user}" unless silent
 * - Optionally update checkpoint per processed message
 */
export async function handleGraphChannelMessage({
  message,
  allTickersFile = "./scanner/all_tickers.txt",
  dbPath = "./scanner/db.json",
  silent = false,
  updateCheckpoint: doCheckpoint = true,
}) {
  const content = message.content?.trim();
  if (!content) {
    if (doCheckpoint) {
      await updateCheckpoint(
        dbPath,
        message.channel.id,
        message.id,
        new Date(message.createdTimestamp).toISOString()
      );
    }
    return;
  }

  const tickerSet = await loadTickerSet(allTickersFile);
  const tickers = extractTickers(content, tickerSet);

  // Persist entries (if any)
  if (tickers.length > 0) {
    const displayName =
      message.member?.nickname ||
      message.member?.displayName ||
      message.author.globalName ||
      message.author.username;

    const entries = tickers.map((ticker) => ({
      ticker,
      user: { id: message.author.id, name: displayName },
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guildId,
      link: message.url,
      timestamp: new Date(message.createdTimestamp).toISOString(),
      content,
    }));

    await appendEntries(dbPath, entries);

    if (!silent) {
      for (const ticker of tickers) {
        await message.channel.send(`logged ticker: ${ticker} from user: ${displayName}`);
      }
    }
  }

  // Always checkpoint the processed message (even if no tickers)
  if (doCheckpoint) {
    await updateCheckpoint(
      dbPath,
      message.channel.id,
      message.id,
      new Date(message.createdTimestamp).toISOString()
    );
  }
}

/**
 * One-time backfill on startup:
 * - If checkpoint exists: fetch messages AFTER that snowflake (forward).
 * - If no checkpoint: generate snowflake for (now - lookbackDays) and fetch AFTER.
 * - Applies same filters as live: ignore bots and @SuperPony mentions.
 * - Runs silently (no "logged ticker" echoes).
 * - Updates checkpoint as it advances.
 */
export async function runBackfillOnce({
  client,
  channelId,
  allTickersFile = "./scanner/all_tickers.txt",
  dbPath = "./scanner/db.json",
  lookbackDays = 14,
}) {
  if (!channelId) throw new Error("runBackfillOnce: channelId is required");
  const channel = await client.channels.fetch(channelId);

  const db = await loadDb(dbPath);
  const cp = db.checkpoints[channelId];

  let afterId;
  if (cp?.lastProcessedId) {
    afterId = cp.lastProcessedId;
  } else {
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    afterId = snowflakeFromTsMs(cutoff);
  }

  let scanned = 0;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, after: afterId });
    if (batch.size === 0) break;

    // Process oldest → newest to keep checkpoint monotonic
    const msgs = Array.from(batch.values()).sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    for (const message of msgs) {
      if (message.author?.bot) continue;

      // skip messages that involve the bot explicitly
      const mentionsBot =
        (client.user?.id && message.mentions.users.has(client.user.id)) ||
        message.content?.includes("@SuperPony");
      if (mentionsBot) continue;

      await handleGraphChannelMessage({
        message,
        allTickersFile,
        dbPath,
        silent: true,
        updateCheckpoint: false, // we will checkpoint once per message below
      });

      await updateCheckpoint(
        dbPath,
        channelId,
        message.id,
        new Date(message.createdTimestamp).toISOString()
      );

      afterId = message.id; // advance window
      scanned++;
    }

    // Keep looping until no newer messages are left
  }

  console.log(`Backfill complete for channel ${channelId}. Scanned ${scanned} messages.`);
}
