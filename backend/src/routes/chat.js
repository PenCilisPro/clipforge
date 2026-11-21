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

/** Chat with the assistant GLM model (any signed-in user). Streams tokens
 *  as server-sent events; a full JSON response is kept for pre-stream
 *  failures (validation, credits, upstream 4xx/5xx) so the client can show
 *  the same error toasts as before. */
router.post("/api/chat", requireAuth, async (req, res, next) => {
  let sseStarted = false;
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
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!aiRes.ok) {
      const detail = (await aiRes.text()).slice(0, 300);
      console.error(`[chat] AI failed (${aiRes.status}):`, detail);
      return res
        .status(502)
        .json({ error: "The assistant is unavailable right now — try again shortly." });
    }
    if (!aiRes.body) {
      return res.status(502).json({ error: "The assistant returned an empty reply." });
    }

    // Switch the response to server-sent events. A JSON body with status 200
    // would also work for the client, but SSE lets tokens land as they come.
    sseStarted = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx/proxies buffer responses unless told otherwise.
      "X-Accel-Buffering": "no",
    });

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    // Upstream streams OpenAI-style SSE lines: `data: {delta…}` … `data: [DONE]`.
    // Chunks can split lines, so carry the remainder across reads.
    let buffer = "";
    let reply = "";
    let upstreamError = null;
    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            reply += delta;
            send({ t: delta });
          }
        } catch {
          // Non-JSON keepalive/comment line — ignore.
        }
      }
    }

    if (!reply.trim()) {
      upstreamError = "The assistant returned an empty reply.";
    }

    if (upstreamError) {
      send({ error: upstreamError });
      res.end();
      return;
    }

    // Charge atomically once the reply is fully delivered — a read-then-write
    // would race on concurrent messages and overdraw credits.
    const { data: left, error: chargeError } = await supabaseAdmin.rpc("deduct_credits", {
      p_user_id: req.user.id,
      p_amount: 1,
    });
    if (chargeError) console.error("[chat] credit charge failed:", chargeError.message);

    send({ done: true, credits_remaining: left != null ? Number(left) : null });
    res.end();
  } catch (err) {
    if (sseStarted) {
      // Headers are already out — report the failure inside the stream.
      try {
        res.write(`data: ${JSON.stringify({ error: "The assistant stream failed." })}\n\n`);
        res.end();
      } catch {
        // Client already gone.
      }
      return;
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? "Invalid chat body" });
    }
    next(err);
  }
});

export default router;
