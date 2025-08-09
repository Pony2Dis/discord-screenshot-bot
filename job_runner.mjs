// job_runner.mjs
import "dotenv/config";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.findIndex(a => a === name || a.startsWith(name + "="));
  if (i === -1) return def;
  const v = args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
  return v ?? def;
}

const JOB_PATH   = path.resolve(getArg("--job", "./super_pony/index.mjs"));
const TIMEOUT_MS = Math.max(1, Number(getArg("--timeout-min", "230"))) * 60 * 1000; // default 230m
const LABEL      = getArg("--label", path.basename(JOB_PATH));

const controller = new AbortController();
const { signal } = controller;

let shuttingDown = false;
let jobModule = null;

function onceShutdown(fn) {
  return async (reason, error, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await fn(reason, error); } catch (e) { console.error("shutdown error:", e); }
    process.exit(exitCode);
  };
}

async function main() {
  console.log(`runner: starting job "${LABEL}" from ${JOB_PATH}`);

  // dynamic import so runner stays generic
  jobModule = await import(pathToFileURL(JOB_PATH).href);

  if (typeof jobModule.runJob !== "function") {
    throw new Error(`Job must export async function runJob(context). Missing in ${JOB_PATH}`);
  }
  if (typeof jobModule.shutdown !== "function") {
    throw new Error(`Job must export async function shutdown(context, reason, error?). Missing in ${JOB_PATH}`);
  }

  // fire a self-timeout (don’t rely on “Cancel”)
  const deadline = Date.now() + TIMEOUT_MS;
  const timeout = setTimeout(() => {
    console.log(`runner: ⏰ timeout reached for "${LABEL}", requesting shutdown…`);
    controller.abort(new Error("TIMEOUT"));
    safeShutdown("TIMEOUT");
  }, TIMEOUT_MS);
  timeout.unref();

  // wire signals → call job.shutdown (no process.kill gymnastics)
  ["SIGTERM","SIGINT","SIGHUP","SIGQUIT"].forEach(sig => {
    process.on(sig, () => {
      console.log(`runner: caught ${sig}, requesting shutdown…`);
      controller.abort(new Error(sig));
      safeShutdown(sig);
    });
  });

  // crash-to-shutdown
  process.on("uncaughtException", (err) => {
    console.error("runner: uncaughtException:", err);
    controller.abort(err);
    safeShutdown("UNCAUGHT_EXCEPTION", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("runner: unhandledRejection:", reason);
    controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    safeShutdown("UNHANDLED_REJECTION", reason);
  });

  // run the job
  try {
    await jobModule.runJob({
      signal,                 // AbortSignal: job can stop loops/intervals
      deadline,               // ms epoch when runner will time out
      label: LABEL,
      env: process.env,
      log: console,           // { log, error, warn, ... }
      args,                   // raw argv if you want extra flags
    });
    // normal completion → still call shutdown for consistent cleanup
    await safeShutdown("NORMAL_EXIT", null, 0);   // ✅ guarded
    clearTimeout(timeout);
  } catch (err) {
    console.error("runner: runJob threw:", err);
    await safeShutdown("RUN_ERROR", err, 1);      // ✅ guarded
    clearTimeout(timeout);
  }
}

const safeShutdown = onceShutdown(async (reason, error) => {
  try {
    await jobModule?.shutdown?.(
      { signal, deadline: Date.now(), label: LABEL, env: process.env, log: console },
      String(reason),
      error
    );
  } catch (e) {
    console.error("runner: shutdown threw:", e);
  }
});

main().catch(async (e) => {
  console.error("runner: fatal init error:", e);
  try { await jobModule?.shutdown?.({ signal, label: LABEL, env: process.env, log: console }, "INIT_ERROR", e); } catch {}
  process.exit(1);
});
