import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";

const router = Router();

const SYSTEM_PROMPT = `You are ClipForge's assistant. ClipForge turns long videos into viral vertical clips (AI hook detection, auto-captions, B-roll, music, multi-channel publishing to YouTube/Instagram/TikTok/Facebook, and scheduled uploads on paid plans).

Help users with how to use the app, content-creation tips, and troubleshooting. Be concise and friendly. Plans: free (1-5 clips per video), pro and business (more clips, multiple channels per platform, scheduled uploads). Users can apply for a free upgrade from the dashboard. Never invent features that don't exist in the list above.`;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
});

const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(24),
});

/** Chat with the assistant GLM model (any signed-in user). */
router.post("/api/chat", requireAuth, async (req, res, next) => {
  try {
    if (!env.chatApiKey) {
      return res
        .status(503)
        .json({ error: "The AI assistant is not configured yet — try again later." });
    }

    const { messages } = chatSchema.parse(req.body);

    const aiRes = await fetch(`${env.chatBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.chatApiKey}`,
      },
      body: JSON.stringify({
        model: env.chatModel,
        temperature: 0.6,
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!aiRes.ok) {
      const detail = (await aiRes.text()).slice(0, 300);
      console.error(`[chat] AI failed (${aiRes.status}):`, detail);
      return res
        .status(502)
        .json({ error: "The assistant is unavailable right now — try again shortly." });
    }

    const reply = (await aiRes.json())?.choices?.[0]?.message?.content;
    if (!reply) {
      return res.status(502).json({ error: "The assistant returned an empty reply." });
    }

    res.json({ reply });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid chat body" });
    }
    next(err);
  }
});

export default router;
