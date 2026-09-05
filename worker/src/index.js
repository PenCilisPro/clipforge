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

const pipelineWorker = new Worker(
  "clipforge-pipeline",
  async (job) => {
    const stage = STAGES[job.name];
    if (!stage) throw new Error(`Unknown pipeline stage: ${job.name}`);
    console.log(`[worker] ▶ ${job.name} (${job.id})`);
    const result = await stage(job);
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
