import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { ensureMonthlyCredits } from "../lib/credits.js";
import { env } from "../config/env.js";

const router = Router();

const SYSTEM_PROMPT = `You are ClipForge's assistant. ClipForge turns long videos into viral vertical clips (AI hook detection, auto-captions, B-roll, music, multi-channel publishing to YouTube/Instagram/TikTok/Facebook, and scheduled uploads on paid plans).

Help users with how to use the app, content-creation tips, and troubleshooting. Be concise and friendly. Plans: free (1-5 clips per video), pro and business (more clips, multiple channels per platform, scheduled uploads). Users can apply for a free upgrade from the dashboard. Never invent features that don't exist in the list above.`;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  // Plain string, or OpenAI-style content parts when the user attached
  // photos (text + image_url parts). GLM vision models accept both shapes.
  content: z.union([
    z.string().trim().min(1).max(4000),
    z
      .array(
        z.union([
          z.object({
            type: z.literal("text"),
            text: z.string().trim().min(1).max(4000),
          }),
          z.object({
            type: z.literal("image_url"),
            image_url: z.object({ url: z.string().url().max(4000) }),
          }),
        ])
      )
      .min(1)
      .max(8),
  ]),
});

const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(24),
});

/** Does any message carry image parts? */
function hasImages(messages) {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
  );
}

/** Chat with the assistant GLM model (any signed-in user). */
router.post("/api/chat", requireAuth, async (req, res, next) => {
  try {
    if (!env.chatApiKey) {
      return res
        .status(503)
        .json({ error: "The AI assistant is not configured yet — try again later." });
    }

    const { messages } = chatSchema.parse(req.body);
    // Image understanding runs on a separate vision model (text-only on the
    // default chat model would silently ignore the pictures).
    if (hasImages(messages) && !env.chatVisionModel) {
      return res
        .status(501)
        .json({ error: "Image understanding isn't configured yet — text still works." });
    }
    const model = hasImages(messages) ? env.chatVisionModel : env.chatModel;

    // Each assistant reply costs 1 credit — block users who are out.
    // (Monthly plan allotments are applied first when due.)
    await ensureMonthlyCredits(req.user.id);
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("credits_remaining")
      .eq("id", req.user.id)
      .single();
    if (!profile || Number(profile.credits_remaining) <= 0) {
      return res.status(402).json({
        error:
          "Out of credits — each AI chat message costs 1 credit. Upgrade your plan to keep chatting.",
      });
    }

    const aiRes = await fetch(`${env.chatBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.chatApiKey}`,
      },
      body: JSON.stringify({
        model,
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

    // Charge atomically — a read-then-write here would race on concurrent
    // messages and overdraw credits. Null result means insufficient credits.
    const { data: left, error: chargeError } = await supabaseAdmin.rpc("deduct_credits", {
      p_user_id: req.user.id,
      p_amount: 1,
    });
    if (chargeError) console.error("[chat] credit charge failed:", chargeError.message);

    res.json({ reply, credits_remaining: left != null ? Number(left) : null });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid chat body" });
    }
    next(err);
  }
});

export default router;
