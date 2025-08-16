// utils/liveLog.mjs
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";

const LOG_DIR = process.env.SUPERPONY_LOG_DIR || "./data/logs";
const exec = promisify(execCb);

async function ensureDir() {
  try { await fs.mkdir(LOG_DIR, { recursive: true }); } catch {}
}

/** Git commit helper (safe to call when nothing changed) */
export async function commitLogIfChanged(logPath) {
  try {
    await exec('git config user.name "github-actions[bot]"');
    await exec('git config user.email "github-actions[bot]@users.noreply.github.com"');

    await exec(`git add "${logPath}"`);
    try {
      await exec("git diff --cached --quiet");
      return false; // nothing to commit
    } catch {}
    await exec('git commit -m "chore(scanner): update channel log json [skip ci]"');
    try {
      await exec("git push");
    } catch {
      try {
        await exec("git pull --rebase --autostash");
        await exec("git push");
      } catch {}
    }
    console.log("✅ Pushed channel log json changes.");
    return true;
  } catch (e) {
    console.error("git commit/push failed:", e?.message || e);
    return false;
  }
}

function channelLogPath(channelId) {
  return path.join(LOG_DIR, `${channelId}.jsonl`);
}

export async function appendToLog(msg) {
  await ensureDir();
  const rec = {
    id: msg.id,
    channelId: msg.channelId,
    authorId: msg.author?.id || null,
    author: msg.author?.username || null,
    content: msg.content || "",
    createdAt: msg.createdAt?.toISOString?.() || new Date().toISOString(),
    attachments: [...(msg.attachments?.values?.() || [])].map(a => ({ url: a.url, name: a.name })),
    referenceId: msg.reference?.messageId || null
  };
  await fs.appendFile(channelLogPath(msg.channelId), JSON.stringify(rec) + "\n", "utf-8");
  await commitLogIfChanged(channelLogPath(msg.channelId));
}

export async function readRecent(channelId, minutes = 60, maxLines = 4000) {
  const p = channelLogPath(channelId);
  let raw = "";
  try { raw = await fs.readFile(p, "utf-8"); } catch { return []; }
  const lines = raw.trim().split("\n");
  const tail = lines.slice(-maxLines);
  const cutoff = Date.now() - minutes * 60 * 1000;
  const items = [];
  for (const line of tail) {
    try {
      const o = JSON.parse(line);
      if (new Date(o.createdAt).getTime() >= cutoff) items.push(o);
    } catch {}
  }
  return items;
}
