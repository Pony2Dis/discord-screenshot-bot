// utils/askGemini.mjs
import fetch from "node-fetch";

/**
 * Ask Google Gemini 1.5 Flash with Hebrew question + recent messages as context.
 * Env:
 *   - GEMINI_API_KEY (required)
 *   - GEMINI_MODEL  (optional, default: gemini-1.5-flash)
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY");
}

function buildHebrewPrompt(question, recent) {
  const header = [
    "אתה עוזר קצר ותכליתי בעברית. עליך לענות על שאלה בהתבסס על ההודעות האחרונות בחדר דיסקורד.",
    "אם אין מספיק מידע – אמור זאת בקצרה. רשום נקודות קצרות וברורות.",
    "הדגש tickers אם קיימים, ואזכור של חדשות אם ישנן.",
    "",
    "### הודעות אחרונות:"
  ].join("\n");

  const convo = recent.map(r => {
    const author = r.author ? `@${r.author}` : (r.authorId || "unknown");
    const when = new Date(r.createdAt).toLocaleString("he-IL");
    const text = (r.content || "").replace(/\s+/g, " ").trim();
    return `- ${when} | ${author}: ${text}`;
  }).join("\n");

  const q = `\n\n### שאלה: ${question}\n\nנא להשיב בעברית קצר ותכליתי.`;

  return `${header}\n${convo}\n${q}`;
}

export async function askGemini(question, recentMessages) {
  const prompt = buildHebrewPrompt(question, recentMessages);

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
}
