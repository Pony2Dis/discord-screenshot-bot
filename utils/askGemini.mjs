import fetch from "node-fetch";
import { readRecent } from "./liveLog.mjs";

/**
 * Ask Google Gemini 1.5/2.5 with a user prompt, using recent messages as context.
 * Env:
 *   - GEMINI_API_KEY (required)
 *   - GEMINI_MODEL (optional, default: gemini-2.5-flash)
 *   - BOT_CHANNEL_ID (optional)
 *   - CONTEXT_CHANNEL_ID (optional)  <-- new, use this if you log a different room
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CHATROOM_IDS = process.env.CHATROOM_IDS || "";

if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY");
  throw new Error("GEMINI_API_KEY is not set in environment variables");
}

// Israel-time formatter for prompt
const IL_TZ = "Asia/Jerusalem";
function israelFormatShort(iso) {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: IL_TZ, year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(d);
}

function buildPrompt(userPrompt, recentMessages) {
  const systemPrompt = [
    "אתה עוזר חכם שמספק תשובות מדויקות ומועילות לשאלות משתמשים בהקשר של שיחות בדיסקורד.",
    "השתמש במידע מההודעות האחרונות כדי לספק תשובה רלוונטית, והשיב בעברית תוך שמירה על טון מקצועי ומכבד.",
    "אם אין מספיק מידע – אמור זאת בקצרה. רשום נקודות קצרות וברורות.",
    "הדגש tickers אם קיימים, ואזכור של חדשות אם ישנן."
  ].join("\n");

  const context = (recentMessages || []).map(r => {
    const author = r.author;
    const when = israelFormatShort(r.createdAt);
    const text = (r.content || "").trim().replace(/\s+/g, " ");
    return `- ${when} | ${author}: ${text}`;
  }).join("\n") || "אין הקשר זמין";

  const prompt = [
    systemPrompt, "",
    "### הקשר (הודעות אחרונות):",
    context, "",
    `### שאלה: ${userPrompt}`, "",
    "נא להשיב בעברית קצר ותכליתי."
  ].join("\n");

  console.log("🔍 Gemini prompt built:", prompt);
  return prompt;
}

export async function askGemini(userPrompt) {
  try {
    const recentMessages = await readRecent(CHATROOM_IDS, 60, 100);
    console.log(`🧠 Gemini using context from channel ${CHATROOM_IDS}`);

    const prompt = buildPrompt(userPrompt, recentMessages);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini HTTP ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return text.trim() || "לא מצאתי מידע רלוונטי בשעה האחרונה.";
  } catch (error) {
    console.error(`Error in askGemini for prompt "${userPrompt}":`, error.message);
    throw new Error("Failed to get response from Gemini API");
  }
}
