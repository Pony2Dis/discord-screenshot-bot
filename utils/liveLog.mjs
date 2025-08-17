import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";

const LOG_DIR = process.env.SUPERPONY_LOG_DIR || "./data/logs";
const exec = promisify(execCb);

// ===== Israel timezone helpers (no deps) =====
const IL_TZ = "Asia/Jerusalem";

function israelDateString(d = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: IL_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value ?? "0000";
  const m = parts.find(p => p.type === "month")?.value ?? "01";
  const day = parts.find(p => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`; // YYYY-MM-DD in Israel local time
}

function israelCutoffMillis(minutes) {
  return Date.now() - minutes * 60 * 1000; // absolute time window
}

async function ensureDir() {
    try { await fs.mkdir(LOG_DIR, { recursive: true }); } catch { }
}

/** Git commit helper (safe to call when nothing changed) */
async function commitLogIfChanged(logPath) {
    try {
        await exec('git config user.name "github-actions[bot]"');
        await exec('git config user.email "github-actions[bot]@users.noreply.github.com"');

        await exec(`git add "${logPath}"`);
        try {
            await exec("git diff --cached --quiet");
            return false; // nothing to commit
        } catch { }
        await exec('git commit -m "chore(scanner): update channel log json [skip ci]"');
        try {
            await exec("git push");
        } catch {
            try {
                await exec("git pull --rebase --autostash");
                await exec("git push");
            } catch { }
        }
        console.log("✅ Pushed channel log json changes.");
        return true;
    } catch (e) {
        console.error("git commit/push failed:", e?.message || e);
        return false;
    }
}

function getDailyLogPath(channelId, date) {
    const formattedDate = israelDateString(date); // YYYY-MM-DD in Israel time
    return path.join(LOG_DIR, `${channelId}_${formattedDate}.jsonl`);
}

function channelLogPath(channelId) {
    return getDailyLogPath(channelId, new Date());
}

function shouldLogMessage(msg) {
    const content = msg.content?.trim() || "";
    if (!content) return false; // Skip empty content, even with attachments

    // Check if only emojis
    const withoutEmojis = content.replace(/[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}\p{Emoji_Presentation}]/gu, '').trim();
    if (!withoutEmojis) return false; // Only emojis, skip

    // Check if it's just a GIF link (e.g., tenor.com)
    if (content.startsWith('https://tenor.com/')) return false; // Skip animated GIF links

    return true; // Has text or regular links, log it
}

export async function appendToLog(msg) {
    if (!shouldLogMessage(msg)) return; // Skip if no text or only emojis/GIF

    await ensureDir();

    let userInitials = msg.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny"; // default to "pny" if empty
    if (userInitials.length > 3) {
        userInitials = userInitials.substring(0, 3);
    }

    let referenceMessageLink = "";
    if (msg.reference?.messageId) {
        referenceMessageLink = `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.reference?.messageId}`;
    }

    const rec = {
        msgLink: `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.id}`,
        refMsgLink: referenceMessageLink,
        author: userInitials || "אנונימי",
        content: msg.content || "",
        createdAt: msg.createdAt?.toISOString?.() || new Date().toISOString(),
        attachments: [...(msg.attachments?.values?.() || [])].map(a => ({ url: a.url, name: a.name })),
    };

    const logPath = channelLogPath(msg.channelId);
    await fs.appendFile(logPath, JSON.stringify(rec) + "\n", "utf-8");
    await commitLogIfChanged(logPath);
}

export async function readRecent(channelId, minutes = 60, maxLines = 4000) {
    const now = new Date();
    const cutoff = israelCutoffMillis(minutes);

    const todayPath = getDailyLogPath(channelId, now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayPath = getDailyLogPath(channelId, yesterday);

    const pathsToRead = [todayPath, yesterdayPath];

    const items = [];
    for (const p of pathsToRead) {
        let raw = "";
        try {
            raw = await fs.readFile(p, "utf-8");
        } catch {
            continue; // missing file is fine
        }
        if (!raw.trim()) continue;
        const lines = raw.split(/\r?\n/).filter(Boolean);
        // We cap after merging both days
        for (let i = Math.max(0, lines.length - maxLines); i < lines.length; i++) {
            const line = lines[i];
            try {
                const o = JSON.parse(line);
                const t = new Date(o.createdAt).getTime();
                if (!Number.isFinite(t)) continue;
                if (t >= cutoff) items.push(o);
            } catch {
                // malformed line — skip
            }
        }
    }

    // Sort ascending by time and cap to maxLines
    items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return items.slice(-maxLines);
}

export async function backfillLastDayMessages(client, channelId) {
    await ensureDir();
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        console.warn(`Channel ${channelId} not found for backfill.`);
        return;
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago

    // Build a per-day bucket so each message is written to its correct daily log (Israel local day)
    const dayBuckets = new Map();

    function yyyy_mm_dd_IL(d) {
        return israelDateString(d);
    }

    async function ensureBucketFor(dateObj) {
        const key = yyyy_mm_dd_IL(dateObj);
        if (dayBuckets.has(key)) return dayBuckets.get(key);
        const pathForDay = getDailyLogPath(channelId, dateObj);
        const bucket = { path: pathForDay, existingIds: new Set(), records: [] };

        // Load existing IDs for that day to prevent duplicates
        try {
            const raw = await fs.readFile(pathForDay, "utf-8");
            const lines = raw.trim() ? raw.trim().split("\n") : [];
            for (const line of lines) {
                try {
                    const o = JSON.parse(line);
                    const msgId = o.msgLink?.split?.("/")?.pop?.();
                    if (msgId) bucket.existingIds.add(msgId);
                } catch { }
            }
        } catch { }

        dayBuckets.set(key, bucket);
        return bucket;
    }

    let lastId;
    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        let stop = false;
        for (const msg of messages.values()) {
            if (msg.createdAt < cutoff) { stop = true; break; }
            if (msg.author.bot) continue;
            if (!shouldLogMessage(msg)) continue;

            const key = yyyy_mm_dd_IL(msg.createdAt);
            // Construct a date object for path derivation (any time during that IL day is fine)
            const parts = key.split("-"); // [yyyy, mm, dd]
            const dtForBucket = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T12:00:00Z`);
            const bucket = await ensureBucketFor(dtForBucket);

            const msgId = msg.id;
            if (bucket.existingIds.has(msgId)) continue;

            let userInitials = msg.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny";
            if (userInitials.length > 3) userInitials = userInitials.substring(0, 3);

            let referenceMessageLink = "";
            if (msg.reference?.messageId) {
                referenceMessageLink = `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.reference?.messageId}`;
            }

            const rec = {
                msgLink: `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.id}`,
                refMsgLink: referenceMessageLink,
                author: userInitials || "אנונימי",
                content: msg.content || "",
                createdAt: msg.createdAt?.toISOString?.() || new Date().toISOString(),
                attachments: [...(msg.attachments?.values?.() || [])].map(a => ({ url: a.url, name: a.name })),
            };
            bucket.records.push(rec);
            bucket.existingIds.add(msgId);
        }
        if (stop) break;
        lastId = messages.last().id;
    }

    // Write per-day and commit
    let total = 0;
    for (const { path: p, records } of dayBuckets.values()) {
        if (records.length === 0) continue;
        const logData = records.map(r => JSON.stringify(r)).join("\n") + "\n";
        await fs.appendFile(p, logData, "utf-8");
        await commitLogIfChanged(p);
        total += records.length;
    }

    if (total > 0) {
        console.log(`✅ Backfilled ${total} messages for channel ${channelId} across ${dayBuckets.size} day file(s).`);
    } else {
        console.log(`No new messages to backfill for channel ${channelId}`);
    }
}
