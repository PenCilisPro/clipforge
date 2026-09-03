import fs from "node:fs/promises";
import speech from "@google-cloud/speech";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, deductCredits } from "../lib/jobs.js";
import { ensureTmpDir, tmpPath, cleanup, extractAudio, probeDurationSeconds } from "../lib/ffmpeg.js";
import { env } from "../lib/env.js";

let speechClient = null;

function getSpeechClient() {
  if (speechClient) return speechClient;
  const options = {};
  if (env.googleCredentialsJson) {
    options.credentials = JSON.parse(env.googleCredentialsJson);
  } else if (env.googleCredentialsPath) {
    options.keyFilename = env.googleCredentialsPath;
  }
  speechClient = new speech.SpeechClient(options);
  return speechClient;
}

/**
 * Stage 2 — transcribe.
 * Downloads the source video, extracts mono 16 kHz WAV with FFmpeg, sends it
 * to Google Speech-to-Text with word-level timestamps and stores the result
 * in projects.transcript_json: { transcript, words: [{word, start, end}] }.
 * Also deducts credits (1 per started minute).
 */
export async function processTranscribe(job) {
  const { projectId, jobRowId } = job.data;

  try {
    await setJobStatus(jobRowId, "active");

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("id, user_id, original_video_path, duration_seconds")
      .eq("id", projectId)
      .single();
    if (error || !project?.original_video_path) {
      throw new Error("Source video not found — download/upload must run first");
    }

    await ensureTmpDir();

    // 1. Pull source video out of storage
    const { data: videoBlob, error: dlError } = await supabaseAdmin.storage
      .from("source-videos")
      .download(project.original_video_path);
    if (dlError) throw dlError;
    const localVideo = tmpPath(`source-${projectId}.mp4`);
    await fs.writeFile(localVideo, Buffer.from(await videoBlob.arrayBuffer()));

    // 2. FFmpeg → mono 16 kHz WAV
    const localAudio = tmpPath(`audio-${projectId}.wav`);
    await extractAudio(localVideo, localAudio);

    const durationSeconds =
      project.duration_seconds ?? (await probeDurationSeconds(localVideo).catch(() => null));
    if (durationSeconds) {
      await supabaseAdmin
        .from("projects")
        .update({ duration_seconds: durationSeconds })
        .eq("id", projectId);
      await deductCredits(project.user_id, durationSeconds);
    }

    // 3. Google Speech-to-Text (long-running, word-level timestamps)
    const audioBytes = await fs.readFile(localAudio);
    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: env.sttLanguage,
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      model: "latest_long",
    };

    const [operation] = await getSpeechClient().longRunningRecognize({
      audio: { content: audioBytes.toString("base64") },
      config,
    });
    job.log("STT operation started — waiting…");
    const [response] = await operation.promise();

    const words = [];
    const transcriptParts = [];
    for (const result of response.results ?? []) {
      const alternative = result.alternatives?.[0];
      if (!alternative) continue;
      transcriptParts.push(alternative.transcript);
      for (const w of alternative.words ?? []) {
        words.push({
          word: w.word,
          start: Number(w.startTime.seconds ?? 0) + Number(w.startTime.nanos ?? 0) / 1e9,
          end: Number(w.endTime.seconds ?? 0) + Number(w.endTime.nanos ?? 0) / 1e9,
        });
      }
    }

    if (words.length === 0) {
      throw new Error("Transcription produced no words — is there speech in this video?");
    }

    const transcriptJson = { transcript: transcriptParts.join(" "), words };
    const { error: updateError } = await supabaseAdmin
      .from("projects")
      .update({ transcript_json: transcriptJson })
      .eq("id", projectId);
    if (updateError) throw updateError;

    await cleanup(localVideo, localAudio);
    await setJobStatus(jobRowId, "completed");
    job.log(`Transcribed ${words.length} words`);
    return { projectId, wordCount: words.length };
  } catch (error) {
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}
