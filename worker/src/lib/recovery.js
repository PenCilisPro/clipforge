import { Queue } from "bullmq";
import IORedis from "ioredis";

import { env } from "./env.js";
import { supabaseAdmin } from "./supabase.js";
import { insertJobRow, setJobStatus, setProjectStatus, reconcileProjectDone } from "./jobs.js";
import { getRender } from "./shotstack.js";

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

async function liveQueueKeys() {
  try {
    const jobs = await queue.getJobs(["waiting", "active", "delayed", "paused"]);
    const clipIds = new Set();
    const jobRowIds = new Set();
    for (const j of jobs) {
      if (j.data?.clipId) clipIds.add(j.data.clipId);
      if (j.data?.jobRowId) jobRowIds.add(j.data.jobRowId);
    }
    return { clipIds, jobRowIds, ok: true };
  } catch (err) {
    console.error("[recovery] could not list queue jobs:", err.message);
    // fail closed — don't double-enqueue blindly
    return { clipIds: new Set(["__none__"]), jobRowIds: new Set(["__none__"]), ok: false };
  }
}

async function clipIdsWithLiveJobs() {
  const { clipIds } = await liveQueueKeys();
  return clipIds;
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

/**
 * Re-enqueue lost pipeline stages (download/transcribe/analyze). The queue is
 * ephemeral — a deploy or container restart wipes Redis while the public.jobs
 * row stays "queued"/"active" in Firestore, so the project spins at
 * "Processing" forever. Stranded render-stage clips are covered by
 * reenqueueStrandedRenders; this covers the pre-render stages.
 */
async function resumeStrandedPipelines() {
  // Single-field "in" query (no composite index needed); filter the rest in JS.
  const { data: jobRows, error } = await supabaseAdmin
    .from("jobs")
    .select("id, project_id, job_type, status, created_at")
    .in("job_type", ["download", "transcribe", "analyze"]);
  if (error) {
    console.error("[recovery] pipeline-jobs query failed:", error.message);
    return;
  }
  const stranded = (jobRows ?? []).filter(
    (j) =>
      ["queued", "active"].includes(j.status) &&
      j.created_at &&
      Date.now() - new Date(j.created_at).getTime() > 10 * 60 * 1000
  );
  if (!stranded.length) return;

  const live = await liveQueueKeys();
  if (!live.ok) return;

  // Only resume projects that are actually still pending/processing.
  const projectIds = [...new Set(stranded.map((j) => j.project_id).filter(Boolean))];
  const resumable = new Set();
  if (projectIds.length) {
    const { data: projects, error: projError } = await supabaseAdmin
      .from("projects")
      .select("id, status")
      .in("id", projectIds);
    if (projError) {
      console.error("[recovery] projects query failed:", projError.message);
      return;
    }
    for (const p of projects ?? []) {
      if (p.status === "pending" || p.status === "processing") resumable.add(p.id);
    }
  }

  let resumed = 0;
  for (const job of stranded) {
    if (live.jobRowIds.has(job.id)) continue; // still queued/active in BullMQ
    if (!resumable.has(job.project_id)) continue;
    try {
      if (Date.now() - new Date(job.created_at).getTime() > 24 * 60 * 60 * 1000) {
        // Too old to be safe — fail it loudly instead of looping forever.
        await setJobStatus(
          job.id,
          "failed",
          "Pipeline job was lost (server restart) and could not be resumed. Please try again."
        );
        await setProjectStatus(
          job.project_id,
          "failed",
          "Processing was interrupted by a server restart — please create the project again."
        );
        console.log(`[recovery] failed stranded >24h pipeline job ${job.id}`);
        continue;
      }
      await queue.add(
        job.job_type,
        { projectId: job.project_id, jobRowId: job.id },
        RECOVERY_JOB_OPTS
      );
      resumed++;
    } catch (err) {
      console.error(`[recovery] failed to resume pipeline job ${job.id}:`, err.message);
    }
  }
  if (resumed > 0) console.log(`[recovery] re-enqueued ${resumed} stranded pipeline job(s)`);
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

/**
 * Poll Shotstack directly for submitted renders that have been waiting more
 * than 5 minutes. The webhook remains the fast path; this guarantees a
 * finished render is still finalized (and a failed one surfaced) even when
 * the webhook never reaches the backend.
 */
async function pollSubmittedRenders() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: clips, error } = await supabaseAdmin
    .from("clips")
    .select("id, project_id, shotstack_render_id")
    .eq("status", "rendering")
    .not("shotstack_render_id", "is", null)
    .is("storage_path", null)
    .or(`render_submitted_at.lt.${cutoff},and(render_submitted_at.is.null,created_at.lt.${cutoff})`)
    .limit(10);
  if (error) {
    console.error("[recovery] poll query failed:", error.message);
    return;
  }
  for (const clip of clips ?? []) {
    let render;
    try {
      render = await getRender(clip.shotstack_render_id);
    } catch (err) {
      console.error(`[recovery] poll render ${clip.shotstack_render_id}:`, err.message);
      continue;
    }
    if (render.status === "done" && render.url) {
      await queue.add(
        "finalize",
        { projectId: clip.project_id, clipId: clip.id, renderUrl: render.url, jobRowId: null },
        { ...RECOVERY_JOB_OPTS, attempts: 5 }
      );
      console.log(`[recovery] render ${clip.shotstack_render_id} done — finalize enqueued via poll`);
    } else if (render.status === "failed" || render.status === "canceled") {
      await supabaseAdmin
        .from("clips")
        .update({
          status: "failed",
          error_message:
            render.error?.message ?? `Shotstack render ${render.status} (found by poll)`,
        })
        .eq("id", clip.id)
        .eq("status", "rendering");
      await reconcileProjectDone(clip.project_id);
    }
    // otherwise still queued/rendering on Shotstack — nothing to do yet
  }
}

export function startRecovery() {
  // Startup: short delay so redis/supabase connections are warm. Age floor of
  // 10 minutes skips clips enqueued moments before a routine restart.
  setTimeout(() => {
    reenqueueStrandedRenders(10 * 60 * 1000).catch((e) =>
      console.error("[recovery] startup pass failed:", e.message)
    );
    resumeStrandedPipelines().catch((e) =>
      console.error("[recovery] startup pipeline-resume pass failed:", e.message)
    );
  }, 15_000);

  const timer = setInterval(() => {
    reenqueueStrandedRenders(30 * 60 * 1000).catch((e) =>
      console.error("[recovery] periodic pass failed:", e.message)
    );
    resumeStrandedPipelines().catch((e) =>
      console.error("[recovery] pipeline-resume pass failed:", e.message)
    );
    pollSubmittedRenders().catch((e) =>
      console.error("[recovery] render-poll pass failed:", e.message)
    );
    failLostWebhookRenders().catch((e) =>
      console.error("[recovery] webhook-timeout pass failed:", e.message)
    );
  }, 60 * 1000);
  timer.unref?.();
}
