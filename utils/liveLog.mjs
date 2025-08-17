import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";

const LOG_DIR = process.env.SUPERPONY_LOG_DIR || "./data/logs";
const exec = promisify(execCb);

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
    const formattedDate = date.toISOString().split("T")[0]; // YYYY-MM-DD
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
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    const logPath = channelLogPath(channelId);

    const items = [];
    const cutoff = Date.now() - minutes * 60 * 1000;

    let raw = "";
    try {
        raw = await fs.readFile(logPath, "utf-8");
    } catch {
        console.warn(`Log file not found for channel ${channelId}: ${logPath}`);
        return items; // Return empty if no log file exists
    }

    const lines = raw.trim().split("\n").slice(-maxLines);
    for (const line of lines) {
        try {
            const o = JSON.parse(line);
            if (new Date(o.createdAt).getTime() >= cutoff) {
                items.push(o);
            }
        } catch {
            console.warn(`Failed to parse line in log: ${line}`);
            continue; // Skip malformed lines
        }
    }
    return items;
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
    const logPath = getDailyLogPath(channelId, now);

    // Read existing messages in today's log to avoid duplicates
    let existingMessageIds = new Set();
    try {
        const raw = await fs.readFile(logPath, "utf-8");
        const lines = raw.trim().split("\n");
        for (const line of lines) {
            try {
                const o = JSON.parse(line);
                const msgId = o.msgLink.split("/").pop();
                existingMessageIds.add(msgId);
            } catch { }
        }
    } catch {
        // File may not exist yet, which is fine
    }

    // Collect messages to append
    const messagesToLog = [];
    let lastId;
    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        let stop = false;
        for (const msg of messages.values()) {
            if (msg.createdAt < cutoff) {
                stop = true;
                break;
            }
            if (!existingMessageIds.has(msg.id) && !msg.author.bot && shouldLogMessage(msg)) {
                let userInitials = msg.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny";
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
                messagesToLog.push(rec);
            }
        }
        if (stop) break;
        lastId = messages.last().id;
    }

    // Write all collected messages at once
    if (messagesToLog.length > 0) {
        const logData = messagesToLog.map(rec => JSON.stringify(rec)).join("\n") + "\n";
        await fs.appendFile(logPath, logData, "utf-8");
        await commitLogIfChanged(logPath);
        console.log(`✅ Backfilled ${messagesToLog.length} messages for channel ${channelId}`);
    } else {
        console.log(`No new messages to backfill for channel ${channelId}`);
    }
}