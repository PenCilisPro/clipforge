import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus } from "../lib/jobs.js";
import { detectViralClips } from "../lib/kimi.js";
import { enqueuePipeline } from "../lib/queues.js";
import { env } from "../lib/env.js";

async function insertJobRow(projectId, jobType, clipId) {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .insert({ project_id: projectId, clip_id: clipId, job_type: jobType, status: "queued" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * Stage 3 — analyze.
 * Sends the transcript to Kimi, persists one `clips` row per suggested
 * segment, and enqueues a render job for each clip.
 *
 * Fallback: if KIMI_API_KEY is not configured, three evenly spaced sample
 * clips are created so the rest of the pipeline (trim → Shotstack → storage)
 * remains testable end-to-end.
 */
export async function processAnalyze(job) {
  const { projectId, jobRowId } = job.data;

  try {
    await setJobStatus(jobRowId, "active");

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("id, transcript_json, duration_seconds")
      .eq("id", projectId)
      .single();
    if (error || !project) throw new Error(`Project ${projectId} not found`);
    if (!project.transcript_json) throw new Error("No transcript — transcribe must run first");

    const durationSeconds = Number(project.duration_seconds ?? 0);

    let suggestions;
    try {
      suggestions = await detectViralClips({
        transcriptJson: project.transcript_json,
        durationSeconds,
        maxClips: env.maxClips,
      });
    } catch (err) {
      if (!env.kimiApiKey) {
        job.log(`Kimi unavailable (${err.message}) — falling back to sample clips`);
        suggestions = buildSampleClips(durationSeconds);
      } else {
        throw err;
      }
    }

    // Persist clip rows
    const clipRows = [];
    for (const suggestion of suggestions) {
      const { data: clipRow, error: insertError } = await supabaseAdmin
        .from("clips")
        .insert({
          project_id: projectId,
          user_id: (await getProjectUser(projectId)),
          title: suggestion.title,
          hook_text: suggestion.hook,
          start_time: suggestion.start,
          end_time: suggestion.end,
          virality_score: suggestion.virality_score,
          reason: suggestion.reason,
          hashtags: suggestion.hashtags,
          status: "queued",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;
      clipRows.push(clipRow.id);
    }

    // Enqueue a render job per clip
    for (const clipId of clipRows) {
      const renderJobRowId = await insertJobRow(projectId, "render", clipId);
      await enqueuePipeline("render", { projectId, clipId, jobRowId: renderJobRowId });
    }

    await setJobStatus(jobRowId, "completed");
    job.log(`Created ${clipRows.length} clips`);
    return { projectId, clipIds: clipRows };
  } catch (error) {
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}

async function getProjectUser(projectId) {
  const { data } = await supabaseAdmin
    .from("projects")
    .select("user_id")
    .eq("id", projectId)
    .single();
  return data?.user_id;
}

function buildSampleClips(durationSeconds) {
  const total = durationSeconds > 0 ? durationSeconds : 600;
  const windows = [
    [Math.min(30, total * 0.1), Math.min(60, total * 0.1) + 30],
    [total * 0.4, total * 0.4 + 35],
    [total * 0.7, total * 0.7 + 40],
  ];
  return windows
    .filter(([s, e]) => e <= total && e > s)
    .map(([start, end], i) => ({
      start,
      end,
      title: `Sample highlight ${i + 1}`,
      hook: "Configure KIMI_API_KEY for AI-selected viral moments.",
      virality_score: 60 + i * 5,
      reason: "Evenly-spaced fallback clip (no AI key configured).",
      hashtags: ["clipforge", "highlights"],
    }));
}
