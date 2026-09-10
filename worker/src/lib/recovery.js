import { Queue } from "bullmq";
import IORedis from "ioredis";

import { env } from "./env.js";
import { supabaseAdmin } from "./supabase.js";
import { insertJobRow, reconcileProjectDone } from "./jobs.js";

/**
 * Queue recovery. Redis here is ephemeral (in-container, wiped on every
 * deploy), but clip status lives in Postgres — so after any restart a clip
 * can be stranded in `queued`/`rendering` with no BullMQ job behind it and
 * the dashboard would spin forever. This module:
 *
 *   1. on worker startup — re-enqueues render jobs for clips that never
 *      reached Shotstack (no shotstack_render_id) and aren't already waiting
 *      in the queue;
 *   2. every 10 minutes — re-enqueues clips stuck that way for over 30
 *      minutes (covers a hung/dead worker tick), and fails clips whose
 *      Shotstack render was submitted but whose webhook never arrived within
 *      2 hours, so the UI stops showing an endless spinner.
 */

const connection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queue = new Queue("clipforge-pipeline", { connection });

const RECOVERY_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 500,
  removeOnFail: 1000,
};

async function clipIdsWithLiveJobs() {
  try {
    const jobs = await queue.getJobs(["waiting", "active", "delayed", "paused"]);
    return new Set(jobs.map((j) => j.data?.clipId).filter(Boolean));
  } catch (err) {
    console.error("[recovery] could not list queue jobs:", err.message);
    return new Set(["__none__"]); // fail closed — don't double-enqueue blindly
  }
}

async function reenqueueStrandedRenders(maxAgeMs) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const { data: clips, error } = await supabaseAdmin
    .from("clips")
    .select("id, project_id, created_at")
    .in("status", ["queued", "rendering"])
    .is("storage_path", null)
    .is("shotstack_render_id", null)
    .lt("created_at", cutoff);
  if (error) {
    console.error("[recovery] query failed:", error.message);
    return;
  }
  if (!clips?.length) return;

  const live = await clipIdsWithLiveJobs();
  let requeued = 0;
  for (const clip of clips) {
    if (live.has(clip.id)) continue;
    try {
      const jobRowId = await insertJobRow(clip.project_id, "render", clip.id);
      await queue.add("render", { projectId: clip.project_id, clipId: clip.id, jobRowId }, RECOVERY_JOB_OPTS);
      requeued++;
    } catch (err) {
      console.error(`[recovery] failed to re-enqueue clip ${clip.id}:`, err.message);
    }
  }
  if (requeued > 0) console.log(`[recovery] re-enqueued ${requeued} stranded clip(s) for render`);
}

async function failLostWebhookRenders() {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  // Judge from when the render was submitted (render_submitted_at), not clip
  // creation — a clip can sit queued for hours before its render starts.
  // Legacy rows without a submission timestamp fall back to created_at.
  const { data: clips, error } = await supabaseAdmin
    .from("clips")
    .select("id, project_id")
    .eq("status", "rendering")
    .not("shotstack_render_id", "is", null)
    .is("storage_path", null)
    .or(`render_submitted_at.lt.${cutoff},and(render_submitted_at.is.null,created_at.lt.${cutoff})`);
  if (error) {
    console.error("[recovery] webhook-timeout query failed:", error.message);
    return;
  }
  if (!clips?.length) return;

  const message =
    "Render timed out — the Shotstack webhook never arrived. Use re-render on this clip to try again.";
  for (const clip of clips) {
    await supabaseAdmin
      .from("clips")
      .update({ status: "failed", error_message: message })
      .eq("id", clip.id)
      .eq("status", "rendering"); // guard: don't clobber a webhook landing mid-check
    await reconcileProjectDone(clip.project_id);
  }
  console.log(`[recovery] marked ${clips.length} lost-webhook render(s) as failed`);
}

export function startRecovery() {
  // Startup: short delay so redis/supabase connections are warm. Age floor of
  // 10 minutes skips clips enqueued moments before a routine restart.
  setTimeout(() => {
    reenqueueStrandedRenders(10 * 60 * 1000).catch((e) =>
      console.error("[recovery] startup pass failed:", e.message)
    );
  }, 15_000);

  const timer = setInterval(() => {
    reenqueueStrandedRenders(30 * 60 * 1000).catch((e) =>
      console.error("[recovery] periodic pass failed:", e.message)
    );
    failLostWebhookRenders().catch((e) =>
      console.error("[recovery] webhook-timeout pass failed:", e.message)
    );
  }, 10 * 60 * 1000);
  timer.unref?.();
}
