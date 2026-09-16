import { Worker } from "bullmq";
import IORedis from "ioredis";

import { env, warnMissing } from "./lib/env.js";
import { ensureTmpDir } from "./lib/ffmpeg.js";
import { processDownload } from "./pipelines/download.js";
import { processTranscribe } from "./pipelines/transcribe.js";
import { processAnalyze } from "./pipelines/analyze.js";
import { processRender } from "./pipelines/render.js";
import { processFinalize } from "./pipelines/finalize.js";
import { processPublish } from "./publish/index.js";
import { startRecovery } from "./lib/recovery.js";

warnMissing();

const connection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const STAGES = {
  download: processDownload,
  transcribe: processTranscribe,
  analyze: processAnalyze,
  render: processRender,
  finalize: processFinalize,
};

// Hard ceiling per pipeline job. Without it a silently hung stage (network
// stall, zombie child process) pins a concurrency slot forever and the whole
// queue deadlocks — recovery.js skips clips that BullMQ still considers live.
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 40 * 60 * 1000;

function withTimeout(stage) {
  return async (job) => {
    return Promise.race([
      stage(job),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${job.name} (${job.id}) timed out after ${Math.round(JOB_TIMEOUT_MS / 60000)} min`)),
          JOB_TIMEOUT_MS
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  };
}

const pipelineWorker = new Worker(
  "clipforge-pipeline",
  async (job) => {
    const stage = STAGES[job.name];
    if (!stage) throw new Error(`Unknown pipeline stage: ${job.name}`);
    console.log(`[worker] ▶ ${job.name} (${job.id})`);
    const result = await withTimeout(stage)(job);
    console.log(`[worker] ✓ ${job.name} (${job.id})`);
    return result;
  },
  {
    connection,
    concurrency: env.concurrency,
    lockDuration: 10 * 60 * 1000, // renders are slow; hold the lock generously
    stalledInterval: 60 * 1000,
    maxStalledCount: 2,
  }
);

const publishingWorker = new Worker("clipforge-publishing", processPublish, {
  connection,
  concurrency: 2,
});

for (const worker of [pipelineWorker, publishingWorker]) {
  worker.on("failed", (job, err) => {
    console.error(`[worker] ✗ ${job?.name} (${job?.id}): ${err.message}`);
  });
  worker.on("error", (err) => {
    console.error(`[worker] worker error:`, err.message);
  });
}

await ensureTmpDir();
startRecovery();

console.log(
  `[worker] ClipForge worker ready — pipeline concurrency ${env.concurrency}, max ${env.maxClips} clips/video`
);

async function shutdown(signal) {
  console.log(`[worker] ${signal} received — closing workers…`);
  await Promise.allSettled([pipelineWorker.close(), publishingWorker.close()]);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
