import fs from "node:fs/promises";
import { supabaseAdmin } from "../lib/supabase.js";
import { setJobStatus, setProjectStatus, deductCredits, insertJobRow } from "../lib/jobs.js";
import { enqueuePipeline } from "../lib/queues.js";
import {
  ensureTmpDir,
  tmpPath,
  cleanup,
  extractRawPcm,
  probeMedia,
  statDiskFree,
  assertDiskSpace,
  sweepStaleTmpFiles,
  describeExtractionFailure,
  isRemoteUnreadableError,
  probeRemoteSize,
  downloadToFile,
} from "../lib/ffmpeg.js";
import {
  fetchSourceVideo,
  isSplitSource,
  sourceStoragePaths,
  assembleSplitSourceInR2,
} from "../lib/source.js";
import { uploadFile as r2UploadFile, remove as r2Remove, presignGet, r2Key } from "../lib/r2.js";
import { env } from "../lib/env.js";

// The Google speech SDK is heavy; load it only when a transcription job
// needs it so the long-lived worker keeps more headroom inside the 512 MB
// service while it handles queue and render-completion jobs.
let speechClient = null;

function googleAuthOptions() {
  if (env.googleCredentialsJson) {
    return { credentials: JSON.parse(env.googleCredentialsJson) };
  }
  if (env.googleCredentialsPath) {
    return { keyFilename: env.googleCredentialsPath };
  }
  return {};
}

async function getSpeechClient() {
  if (speechClient) return speechClient;
  const speech = (await import("@google-cloud/speech")).default;
  speechClient = new speech.SpeechClient(googleAuthOptions());
  return speechClient;
}

/**
 * Stage 2 — transcribe.
 * Extracts the audio in a single ffmpeg pass into raw mono 16 kHz PCM, then
 * transcribes fixed 55-second byte ranges serially — one STT request at a
 * time and at most one chunk payload in RAM, so neither CPU, memory, nor
 * disk scale with the number of chunks.
 */
export async function processTranscribe(job) {
  const { projectId, jobRowId } = job.data;
  let localVideo = null;
  let pcmFile = null;

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

    // 1. Hand ffmpeg the shortest path to the audio. The container has only
    //    ~1 GiB of ephemeral disk, so a source-sized MP4 must NOT land here:
    //    - regular uploads: presign the R2 object and let ffprobe/ffmpeg
    //      stream it over HTTP — the file never touches local disk at all;
    //    - split uploads (legacy multipart path): the parts must be
    //      reassembled locally, merged into one object, then processed.
    let mediaSource; // local file path OR presigned https URL
    if (!isSplitSource(project.original_video_path)) {
      // Same ownership guard fetchSourceVideo enforces for downloads — the
      // presigned URL would otherwise bypass it.
      if (!String(project.original_video_path).startsWith(`${project.user_id}/`)) {
        throw new Error("Source video path does not belong to the project owner");
      }
      // TTL covers the whole stage (extraction + chunked STT loop).
      mediaSource = await presignGet(
        r2Key("source-videos", project.original_video_path),
        6 * 60 * 60
      );
    } else {
      const previousPath = project.original_video_path;
      const canonicalPath = `${project.user_id}/${projectId}.mp4`;

      // Preferred: assemble the split upload ON R2 — every part streams
      // straight into the final single object, so the source-sized file
      // never touches the ~1 GiB ephemeral disk. (Local reassembly filled
      // the disk by itself and starved the transcription audio — every
      // large upload failed with ENOSPC.)
      let assembledInR2 = false;
      try {
        const totalBytes = await assembleSplitSourceInR2(project, canonicalPath);
        assembledInR2 = true;
        console.log(
          `[transcribe] assembled split source in R2 (${Math.round(totalBytes / 1048576)} MB) — no local reassembly needed`
        );
      } catch (err) {
        console.warn(
          `[transcribe] R2-side assembly failed (${err.message}) — falling back to local reassembly`
        );
      }

      if (!assembledInR2) {
        // Legacy fallback: local reassembly (disk-heavy). Free stranded
        // leftovers first — this writes the biggest local file in the
        // whole pipeline.
        await sweepStaleTmpFiles();
        localVideo = tmpPath(`source-${projectId}.mp4`);
        await fetchSourceVideo(project, localVideo);
        await r2UploadFile(`source-videos/${canonicalPath}`, localVideo, "video/mp4");
      }

      const { error: pathError } = await supabaseAdmin
        .from("projects")
        .update({ original_video_path: canonicalPath })
        .eq("id", projectId);
      if (pathError) throw pathError;
      project.original_video_path = canonicalPath;
      const oldPaths = await sourceStoragePaths(previousPath);
      await r2Remove(oldPaths.map((sourcePath) => `source-videos/${sourcePath}`)).catch((err) => {
        console.warn(`[transcribe] could not remove split source parts: ${err.message}`);
      });
      mediaSource = assembledInR2
        ? await presignGet(r2Key("source-videos", canonicalPath), 6 * 60 * 60)
        : localVideo;
    }

    // Audio check — FAIL-SAFE against probe failures. probeMedia reads the
    // media over a presigned https URL for every R2-backed project; a
    // transient HTTP/TLS/ffprobe failure there used to be misread as "no
    // audio track" and failed perfectly healthy videos. Now only a probe
    // that SUCCEEDED and reports zero audio streams rejects the file — a
    // broken probe continues and lets the extraction itself be the arbiter
    // (its failures are mapped to readable messages below).
    const probe = await probeMedia(mediaSource).catch((err) => {
      console.warn(
        `[transcribe] media probe failed (${err?.message ?? err}) — continuing; audio extraction will confirm whether an audio track exists`
      );
      return null;
    });
    if (probe && !(probe.streams ?? []).some((stream) => stream.codec_type === "audio")) {
      throw new Error(
        "This video has no audio track — the source file is a video-only encode " +
          "(files ending in .fNNN, e.g. video.f401.mp4). For a pasted link, re-run " +
          "the project (the downloader verifies the audio track is merged); for an " +
          "upload, use a version of the video that has sound."
      );
    }

    // Duration resolution — three sources, tried in order:
    //   1. the media probe above (container duration, or per-stream duration
    //      when the container header says N/A);
    //   2. duration_seconds stored by the download stage (URL projects);
    //   3. DERIVED FROM THE EXTRACTED AUDIO after extraction below.
    // Source 3 is why a missing duration is no longer fatal: raw yt-dlp DASH
    // downloads (.webm/.opus files that were never remuxed) report duration
    // "N/A", and upload projects have no stored value until this stage
    // succeeds — while the extracted PCM byte count is an exact ground
    // truth (32 000 B/s) for everything this stage does with the duration.
    const storedDuration = Number(project.duration_seconds);
    let durationSeconds =
      probe && probe.duration > 0 ? probe.duration : storedDuration > 0 ? storedDuration : null;
    let durationKnown = Number.isFinite(durationSeconds) && durationSeconds > 0;

    // Credits are per processed video, not per retry — only the first
    // attempt pays, otherwise each failed retry burns more minutes.
    const commitDuration = async (seconds) => {
      if (job.attemptsMade) return;
      await supabaseAdmin
        .from("projects")
        .update({ duration_seconds: seconds })
        .eq("id", projectId);
      await deductCredits(project.user_id, seconds);
    };
    if (durationKnown) {
      await commitDuration(durationSeconds);
    } else {
      console.log(
        "[transcribe] no duration from probe or DB (common for raw DASH .webm " +
          "uploads) — deriving it from the extracted audio after extraction"
      );
    }

    // 2. Extract the audio once, then slice it in memory. A full-length PCM
    // WAV takes ~115 MB per hour on disk, and re-running ffmpeg on a
    // source-sized video once per 55-second chunk would saturate the
    // constrained 0.2 vCPU service for the whole transcription. One pass
    // writes raw mono 16 kHz PCM; each STT request then reads a fixed byte
    // range (32 000 B/s × 55 s ≈ 1.7 MB, well under Google's 10 MiB inline
    // and 60 s limits) through a single reused buffer.
    const BYTES_PER_SECOND = 16000 * 2; // 16 kHz × 16-bit mono PCM on disk

    // Disk pre-flight: raw mono 16 kHz PCM is exactly BYTES_PER_SECOND
    // (32 000 B/s ≈ 115 MB/hour). Failing HERE with a readable reason beats
    // dying 20 minutes into ffmpeg with a cryptic "Error muxing a packet:
    // No space left on device" (exit 228 = ENOSPC). The legacy split-upload
    // path already spent its source-sized bytes on disk above — what must
    // still fit is the PCM plus a safety margin.
    const pcmEstimate = durationKnown
      ? Math.ceil(durationSeconds * BYTES_PER_SECOND * 1.02)
      : // Unknown length: require room for ~3.4 h of audio. If the source is
        // somehow longer, extraction itself fails with the readable ENOSPC
        // error instead of this pre-flight guess.
        400 * 1024 * 1024;
    const freeBytes = await statDiskFree();
    if (freeBytes != null) {
      console.log(
        `[transcribe] tmp disk: ${Math.round(freeBytes / 1048576)} MB free, ` +
          `PCM estimate ${Math.round(pcmEstimate / 1048576)} MB`
      );
    }
    await assertDiskSpace(pcmEstimate + 128 * 1024 * 1024, {
      label: "audio extraction",
      // The aggressive reclaim tier must never delete THIS job's own split-
      // path source file — it is ffmpeg's input for the extraction below.
      protect: localVideo ? [localVideo] : [],
    });

    pcmFile = tmpPath(`audio-${projectId}.pcm`);
    try {
      await extractRawPcm(mediaSource, pcmFile);
    } catch (err) {
      const rawMessage = err?.message ?? "";
      // Two very different failure families need opposite responses:
      //  - the FILE is bad (no audio stream) → re-reading it from a local
      //    copy cannot help, so surface the readable error and stop;
      //  - the worker's ffmpeg could not READ the remote input (DNS/TLS/
      //    transport — the static-glibc binaries cannot resolve anything on
      //    Alpine musl containers) → download the source with Node, whose
      //    resolver works, and extract from the local copy.
      const remoteInput = /^https?:\/\//i.test(String(mediaSource));
      if (!remoteInput || !isRemoteUnreadableError(rawMessage)) {
        const friendly = describeExtractionFailure(rawMessage);
        if (friendly) throw new Error(friendly);
        throw err;
      }

      console.warn(
        `[transcribe] remote extraction failed (${rawMessage.slice(0, 200)}) — ` +
          "downloading the source locally and retrying (the worker's ffmpeg " +
          "cannot read the storage URL, but Node can)"
      );

      // Size the download BEFORE it lands: a 1-byte Range probe on the
      // presigned URL reveals the total size, and a source-sized file is
      // the biggest thing this stage ever writes to the ~1 GiB disk.
      const sourceBytes = await probeRemoteSize(mediaSource);
      if (sourceBytes != null) {
        console.log(
          `[transcribe] local retry: source is ${Math.round(sourceBytes / 1048576)} MB — checking disk`
        );
        await assertDiskSpace(sourceBytes + 64 * 1024 * 1024, {
          label: "local source download",
        });
      }

      localVideo = tmpPath(`source-${projectId}.local`);
      await downloadToFile(mediaSource, localVideo);

      // A local probe usually recovers what the remote probe could not —
      // duration especially (raw DASH containers report N/A), and the
      // audio-stream layout. Never rejects the file by itself: a failed
      // local probe just leaves the PCM-derived fallback in charge.
      const localProbe = await probeMedia(localVideo).catch(() => null);
      if (!durationKnown && localProbe?.duration > 0) {
        durationSeconds = localProbe.duration;
        durationKnown = true;
        console.log(
          `[transcribe] local probe recovered duration: ${durationSeconds.toFixed(0)}s`
        );
        await commitDuration(durationSeconds);
      }
      const pcmRetryEstimate = durationKnown
        ? Math.ceil(durationSeconds * BYTES_PER_SECOND * 1.02)
        : 400 * 1024 * 1024;
      await assertDiskSpace(pcmRetryEstimate + 64 * 1024 * 1024, {
        label: "audio extraction (local retry)",
        // Never let the aggressive sweep tier delete the source we just
        // downloaded — it is ffmpeg's input for the retry below.
        protect: [localVideo],
      });

      try {
        await extractRawPcm(localVideo, pcmFile);
        console.log("[transcribe] audio extraction succeeded from the local copy");
      } catch (retryErr) {
        const friendly = describeExtractionFailure(retryErr?.message ?? "");
        if (friendly) throw new Error(friendly);
        throw retryErr;
      }
    }
    // The source is no longer needed locally — render works off the R2
    // object — so free its disk before the long transcription loop. (Both
    // the split path and the remote-read fallback may have landed a local
    // copy; cleanup(null) is a no-op when they did not.)
    await cleanup(localVideo);
    localVideo = null;

    const chunkSeconds = 55;
    const chunkBytes = chunkSeconds * BYTES_PER_SECOND;
    const { size: pcmBytes } = await fs.stat(pcmFile);
    const chunkCount = Math.ceil(pcmBytes / chunkBytes);

    if (!durationKnown) {
      // Ground truth from the audio itself: raw mono 16 kHz PCM is exactly
      // BYTES_PER_SECOND, so the byte count IS the playable duration no
      // matter what the container metadata claimed (or failed to claim).
      durationSeconds = pcmBytes / BYTES_PER_SECOND;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error(
          "Could not determine the source video duration — audio extraction " +
            "produced 0 bytes (no readable audio in the source)"
        );
      }
      console.log(
        `[transcribe] derived duration from extracted audio: ${durationSeconds.toFixed(0)}s`
      );
      await commitDuration(durationSeconds);
    }

    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: env.sttLanguage,
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      model: "latest_long",
    };
    const toSeconds = (time) =>
      time == null
        ? 0
        : typeof time === "number"
          ? time
          : Number(time.seconds ?? 0) + Number(time.nanos ?? 0) / 1e9;

    const words = [];
    const transcriptParts = [];
    const client = await getSpeechClient();
    const pcm = await fs.open(pcmFile, "r");
    const buffer = Buffer.alloc(chunkBytes);
    try {
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const start = chunkIndex * chunkSeconds;
        const { bytesRead } = await pcm.read(buffer, 0, chunkBytes, chunkIndex * chunkBytes);
        const [operation] = await client.longRunningRecognize({
          audio: { content: buffer.subarray(0, bytesRead).toString("base64") },
          config,
        });
        const [response] = await operation.promise();
        for (const result of response.results ?? []) {
          const alternative = result.alternatives?.[0];
          if (!alternative) continue;
          transcriptParts.push(alternative.transcript);
          for (const word of alternative.words ?? []) {
            words.push({
              word: word.word,
              start: toSeconds(word.startTime) + start,
              end: toSeconds(word.endTime) + start,
            });
          }
        }
        job.log(
          `Transcribed segment ${chunkIndex + 1} (${Math.min(start + chunkSeconds, durationSeconds).toFixed(0)} / ${durationSeconds.toFixed(0)}s)`
        );
      }
    } finally {
      await pcm.close().catch(() => {});
    }

    await cleanup(pcmFile);
    pcmFile = null;

    if (words.length === 0) {
      throw new Error("Transcription produced no words — is there speech in this video?");
    }

    const transcriptJson = { transcript: transcriptParts.join(" "), words };
    const { error: updateError } = await supabaseAdmin
      .from("projects")
      .update({ transcript_json: transcriptJson })
      .eq("id", projectId);
    if (updateError) throw updateError;

    if (project.project_mode === "transcript") {
      await setProjectStatus(projectId, "done");
      await setJobStatus(jobRowId, "completed");
      job.log(`Transcript ready (${words.length} words) — transcript-only project, done.`);
      return { projectId, wordCount: words.length, transcriptOnly: true };
    }

    await setJobStatus(jobRowId, "completed");
    const analyzeJobRowId = await insertJobRow(projectId, "analyze");
    await enqueuePipeline("analyze", { projectId, jobRowId: analyzeJobRowId });
    job.log(`Transcribed ${words.length} words`);
    return { projectId, wordCount: words.length };
  } catch (error) {
    // Clean partial media even if download, extraction, or STT fails.
    await cleanup(localVideo, pcmFile);
    await setJobStatus(jobRowId, "failed", error.message);
    await setProjectStatus(projectId, "failed", error.message);
    throw error;
  }
}