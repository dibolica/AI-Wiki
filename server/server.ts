import express from "express";
import cors from "cors";
import morgan from "morgan";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3001);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b-instruct";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    credentials: false,
    methods: ["POST", "OPTIONS"],
  })
);
app.use(morgan("tiny"));

const Eli5Body = z.object({
  text: z.string().min(1).max(20000), // we paraphrase fetched text only
});

const SYSTEM_PROMPT = `
You are a careful simplifier. Rewrite the user's provided text for a 10-year-old.
CRITICAL:
- Do NOT add new facts.
- Do NOT invent numbers, dates, or names.
- Keep it short, simple, and factual.
- Use small, clear sentences. Keep the meaning.
- If the input is too short or unclear, say: "Not enough info to simplify."
`;

app.post("/api/eli5", async (req, res) => {
  try {
    const { text } = Eli5Body.parse(req.body);

    // Guardrail: if text is extremely short, skip LLM.
    if (text.trim().length < 40) {
      return res.json({ eli5: "Not enough info to simplify." });
    }

    // Ollama generate
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "Simplify this for a 10-year-old. Keep facts only; do not add anything:\n\n" +
              text,
          },
        ],
        options: {
          temperature: 0.2,
          num_ctx: 4096
        }
      }),
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => r.statusText);
      return res
        .status(503)
        .json({ error: "Ollama unavailable", detail: msg || r.statusText });
    }

    const j: any = await r.json();
    const content =
      j?.message?.content ??
      j?.result ??
      j?.response ??
      "";

    return res.json({ eli5: (content || "").trim() });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || "Bad request" });
  }
});

app.listen(PORT, () => {
  console.log(`AI-Wiki API listening on http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Using Ollama at: ${OLLAMA_URL} (model: ${OLLAMA_MODEL})`);
});
