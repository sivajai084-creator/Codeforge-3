import express from "express";

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const LANGS = ["Python","JavaScript","TypeScript","Java","C","C++","C#","Go","Rust","PHP","Ruby","Swift","Kotlin","SQL","Bash","R","Dart","Lua"];
const TEMPLATES = {
  gen: "Write clean, correct, idiomatic {L} code for this request: {T}\nReply with one short sentence of context, one fenced code block tagged with the language (brief comments), then 2–4 sentences on how to run it.",
  exp: "Explain this {L} code step by step for a learner. Start with a one-line summary, then walk through it in short points, then note any gotchas:\n\n{T}",
  con: "Convert the following code to idiomatic {L}. Reply with one fenced code block tagged {L}, then 2–3 sentences on notable differences:\n\n{T}",
  dbg: "Find and fix the bugs in this {L} code. Explain each bug briefly, then give the full corrected code in one fenced code block tagged {L}:\n\n{T}"
};

// Simple per-IP rate limit: 15 requests per 10 minutes
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 15;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

app.set("trust proxy", 1);

app.post("/api/generate", async (req, res) => {
  const { mode, lang, text } = req.body || {};
  if (!TEMPLATES[mode] || !LANGS.includes(lang) || typeof text !== "string" || !text.trim() || text.length > 12000) {
    return res.status(400).json({ error: "Invalid request." });
  }
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests. Please wait a few minutes." });
  if (!process.env.LLM_API_KEY) return res.status(500).json({ error: "Server is missing LLM_API_KEY." });

  const BASE = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1";
  const prompt = TEMPLATES[mode].replace(/\{L\}/g, lang).replace("{T}", () => text);
  try {
    const r = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + process.env.LLM_API_KEY
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
        max_tokens: 2000,
        stream: true,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) {
      console.error("LLM error", r.status, await r.text());
      return res.status(502).json({ error: "The AI service returned an error. Try again." });
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          const t = ev.choices?.[0]?.delta?.content;
          if (t) res.write(t);
        } catch {}
      }
    }
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "Server error. Try again." });
    else res.end();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("CodeForge running on port " + port));
