import fs from "node:fs/promises";
import speech from "@google-cloud/speech";
import { Storage } from "@google-cloud/storage";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, deductCredits, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import { ensureTmpDir, tmpPath, cleanup, extractAudio, probeDurationSeconds } from "../lib/ffmpeg.js";
import { fetchSourceVideo } from "../lib/source.js";
import { env } from "../lib/env.js";

let speechClient = null;
let storageClient = null;

function googleAuthOptions() {
  if (env.googleCredentialsJson) {
    return { credentials: JSON.parse(env.googleCredentialsJson) };
  }
  if (env.googleCredentialsPath) {
    return { keyFilename: env.googleCredentialsPath };
  }
  return {};
}

function getSpeechClient() {
  if (speechClient) return speechClient;
  speechClient = new speech.SpeechClient(googleAuthOptions());
  return speechClient;
}

function getStorageClient() {
  if (storageClient) return storageClient;
  storageClient = new Storage(googleAuthOptions());
  return storageClient;
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

    // 1. Pull source video out of storage (reassembles split uploads)
    const localVideo = tmpPath(`source-${projectId}.mp4`);
    await fetchSourceVideo(project, localVideo);

    // 2. FFmpeg → mono 16 kHz WAV
    const localAudio = tmpPath(`audio-${projectId}.wav`);
    await extractAudio(localVideo, localAudio);

    const durationSeconds =
      project.duration_seconds ?? (await probeDurationSeconds(localVideo).catch(() => null));
    // Credits are per processed video, not per retry — only the first
    // attempt pays, otherwise each failed retry burns more minutes.
    if (durationSeconds && !job.attemptsMade) {
      await supabaseAdmin
        .from("projects")
        .update({ duration_seconds: durationSeconds })
        .eq("id", projectId);
      await deductCredits(project.user_id, durationSeconds);
    }

    // 3. Google Speech-to-Text (long-running, word-level timestamps)
    const audioBuffer = await fs.readFile(localAudio);
    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: env.sttLanguage,
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      model: "latest_long",
    };

    // The STT request payload (base64 = 4/3 of raw size) is hard-capped at
    // 10 MiB by Google — past ~5 minutes of WAV the audio must go via GCS.
    let audio;
    let gcsObjectPath = null;
    const payloadBytes = Math.ceil((audioBuffer.length * 4) / 3);
    if (payloadBytes > 9 * 1024 * 1024) {
      if (!env.gcsBucket) {
        throw new Error(
          `Audio is ${Math.round(audioBuffer.length / 1024 / 1024)} MB — over Google STT's ` +
            "10 MiB inline limit. Set GCS_BUCKET on the worker (a Cloud Storage bucket the " +
            "service account can write) to transcribe longer videos."
        );
      }
      gcsObjectPath = `stt/${projectId}/${Date.now()}.wav`;
      job.log(
        `Audio ${Math.round(audioBuffer.length / 1024 / 1024)} MB — uploading to ` +
          `gs://${env.gcsBucket}/${gcsObjectPath} for transcription`
      );
      await getStorageClient()
        .bucket(env.gcsBucket)
        .upload(localAudio, {
          destination: gcsObjectPath,
          resumable: false,
          contentType: "audio/wav",
        });
      audio = { uri: `gs://${env.gcsBucket}/${gcsObjectPath}` };
    } else {
      audio = { content: audioBuffer.toString("base64") };
    }

    const [operation] = await getSpeechClient().longRunningRecognize({ audio, config });
    job.log("STT operation started — waiting…");
    const [response] = await operation.promise();

    if (gcsObjectPath) {
      await getStorageClient()
        .bucket(env.gcsBucket)
        .file(gcsObjectPath)
        .delete({ ignoreNotFound: true })
        .catch(() => {});
    }

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
    // Chain to the next stage — nothing else enqueues analyze.
    const analyzeJobRowId = await insertJobRow(projectId, "analyze");
    await enqueuePipeline("analyze", { projectId, jobRowId: analyzeJobRowId });
    job.log(`Transcribed ${words.length} words`);
    return { projectId, wordCount: words.length };
  } catch (error) {
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}
