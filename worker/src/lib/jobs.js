import { supabaseAdmin } from "./supabase.js";

/**
 * Keep the public.jobs row (and therefore the dashboard) in sync with the
 * BullMQ job lifecycle.
 */
export async function setJobStatus(jobRowId, status, errorMessage = null) {
  if (!jobRowId) return;
  await supabaseAdmin
    .from("jobs")
    .update({ status, error_message: errorMessage })
    .eq("id", jobRowId);
}

export async function setProjectStatus(projectId, status, errorMessage = null) {
  const { error } = await supabaseAdmin
    .from("projects")
    .update({
      status,
      error_message: status === "failed" ? errorMessage : null,
    })
    .eq("id", projectId);
  if (error) console.error("[project-status]", error.message);
}

export async function setClipStatus(clipId, fields) {
  const { error } = await supabaseAdmin
    .from("clips")
    .update(fields)
    .eq("id", clipId);
  if (error) console.error("[clip-status]", error.message);
}

/** Create the public.jobs row that tracks a BullMQ pipeline job in the dashboard. */
export async function insertJobRow(projectId, jobType, clipId = null) {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .insert({ project_id: projectId, clip_id: clipId, job_type: jobType, status: "queued" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Called after render/finalize so the project flips to done when all clips land. */
export async function reconcileProjectDone(projectId) {
  const { data: clips } = await supabaseAdmin
    .from("clips")
    .select("status")
    .eq("project_id", projectId);

  if (!clips || clips.length === 0) return;

  const allDone = clips.every((c) => c.status === "ready" || c.status === "failed");
  if (allDone) {
    const anyReady = clips.some((c) => c.status === "ready");
    await setProjectStatus(
      projectId,
      anyReady ? "done" : "failed",
      anyReady ? null : "No clips could be rendered"
    );
  } else {
    await setProjectStatus(projectId, "processing");
  }
}

/** Deduct credits (1 per started minute), clamped at zero. */
export async function deductCredits(userId, seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("credits_remaining")
    .eq("id", userId)
    .single();
  if (!profile) return;
  const next = Math.max(0, Number(profile.credits_remaining) - minutes);
  await supabaseAdmin
    .from("profiles")
    .update({ credits_remaining: next })
    .eq("id", userId);
  console.log(`[credits] user ${userId}: -${minutes} min → ${next} left`);
}
