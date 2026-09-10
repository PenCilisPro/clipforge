import fs from "node:fs/promises";
import speech from "@google-cloud/speech";
import { Storage } from "@google-cloud/storage";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, deductCredits, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import { ensureTmpDir, tmpPath, cleanup, extractAudio, probeDurationSeconds, probeStreams, splitAudioChunks } from "../lib/ffmpeg.js";
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
      .select("id, user_id, original_video_path, duration_seconds, project_mode")
      .eq("id", projectId)
      .single();
    if (error || !project?.original_video_path) {
      throw new Error("Source video not found — download/upload must run first");
    }

    await ensureTmpDir();

    // 1. Pull source video out of storage (reassembles split uploads)
    const localVideo = tmpPath(`source-${projectId}.mp4`);
    await fetchSourceVideo(project, localVideo);

    // Fail early with a readable message when the upload has no audio track
    // (yt-dlp video-only downloads keep a ".fNNN" format suffix in the name).
    const hasAudio = (await probeStreams(localVideo).catch(() => [])).some(
      (s) => s.codec_type === "audio"
    );
    if (!hasAudio) {
      await cleanup(localVideo);
      throw new Error(
        "This video has no audio track — it looks like a video-only download " +
          "(filenames ending in .fNNN, e.g. .f401). Re-download with audio merged " +
          "(yt-dlp's default format selection does this) and re-upload."
      );
    }

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
    // 10 MiB by Google — past ~5 minutes of WAV the audio must go via GCS
    // (when GCS_BUCKET is set) or be split into inline-sized chunks.
    const toSeconds = (t) =>
      t == null
        ? 0
        : typeof t === "number"
          ? t
          : Number(t.seconds ?? 0) + Number(t.nanos ?? 0) / 1e9;

    let gcsObjectPath = null;
    let chunkFiles = [];
    let sttResults;
    const payloadBytes = Math.ceil((audioBuffer.length * 4) / 3);
    if (payloadBytes > 9 * 1024 * 1024 && env.gcsBucket) {
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
      const [operation] = await getSpeechClient().longRunningRecognize({
        audio: { uri: `gs://${env.gcsBucket}/${gcsObjectPath}` },
        config,
      });
      job.log("STT operation started — waiting…");
      const [response] = await operation.promise();
      sttResults = response.results ?? [];
    } else if (payloadBytes > 9 * 1024 * 1024) {
      // No GCS bucket configured — split the audio into chunks that each fit
      // the inline limit and transcribe them with the chunk start offset.
      const chunks = await splitAudioChunks(localAudio);
      chunkFiles = chunks.map((c) => c.path);
      job.log(
        `Audio ${Math.round(audioBuffer.length / 1024 / 1024)} MB exceeds the STT ` +
          `inline limit — transcribing in ${chunks.length} chunks`
      );
      const transcribeChunk = async ({ path, startSeconds }, index) => {
        const buffer = await fs.readFile(path);
        const [op] = await getSpeechClient().longRunningRecognize({
          audio: { content: buffer.toString("base64") },
          config,
        });
        const [response] = await op.promise();
        job.log(`Chunk ${index + 1}/${chunks.length} done`);
        return (response.results ?? [])
          .map((result) => {
            const alternative = result.alternatives?.[0];
            if (!alternative) return null;
            return {
              alternatives: [
                {
                  transcript: alternative.transcript,
                  words: (alternative.words ?? []).map((w) => ({
                    ...w,
                    startTime: toSeconds(w.startTime) + startSeconds,
                    endTime: toSeconds(w.endTime) + startSeconds,
                  })),
                },
              ],
            };
          })
          .filter(Boolean);
      };
      // Small concurrency: STT bills per audio second anyway, and parallel
      // requests keep a long video from serializing into a wall-clock slog.
      sttResults = [];
      const CONCURRENCY = 3;
      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        sttResults.push(
          ...(await Promise.all(
            chunks.slice(i, i + CONCURRENCY).map((chunk, j) => transcribeChunk(chunk, i + j))
          )).flat()
        );
      }
    } else {
      const [operation] = await getSpeechClient().longRunningRecognize({
        audio: { content: audioBuffer.toString("base64") },
        config,
      });
      job.log("STT operation started — waiting…");
      const [response] = await operation.promise();
      sttResults = response.results ?? [];
    }

    if (gcsObjectPath) {
      await getStorageClient()
        .bucket(env.gcsBucket)
        .file(gcsObjectPath)
        .delete({ ignoreNotFound: true })
        .catch(() => {});
    }

    const words = [];
    const transcriptParts = [];
    for (const result of sttResults) {
      const alternative = result.alternatives?.[0];
      if (!alternative) continue;
      transcriptParts.push(alternative.transcript);
      for (const w of alternative.words ?? []) {
        words.push({
          word: w.word,
          start: toSeconds(w.startTime),
          end: toSeconds(w.endTime),
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

    await cleanup(localVideo, localAudio, ...chunkFiles);

    // Transcript-only projects stop here: no AI analysis, no clip rows, no
    // renders — the transcript on the project row IS the deliverable.
    if (project.project_mode === "transcript") {
      await setProjectStatus(projectId, "done");
      await setJobStatus(jobRowId, "completed");
      job.log(`Transcript ready (${words.length} words) — transcript-only project, done.`);
      return { projectId, wordCount: words.length, transcriptOnly: true };
    }

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
