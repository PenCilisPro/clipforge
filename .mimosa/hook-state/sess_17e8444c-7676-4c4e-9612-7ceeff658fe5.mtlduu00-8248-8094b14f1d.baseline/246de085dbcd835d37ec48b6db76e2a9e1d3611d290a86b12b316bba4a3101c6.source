import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env.js";

const connection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const pipelineQueue = new Queue("clipforge-pipeline", { connection });
export const publishingQueue = new Queue("clipforge-publishing", { connection });

/**
 * Enqueue a pipeline stage. `jobRowId` links the BullMQ job to the row in the
 * public.jobs table so the worker can keep the dashboard in sync.
 */
export async function enqueuePipeline(name, data, opts = {}) {
  return pipelineQueue.add(name, data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
    ...opts,
  });
}

export async function enqueuePublish(scheduledPostId, runAt, bullMeta = {}) {
  const job = await publishingQueue.add(
    "publish",
    { scheduledPostId, ...bullMeta },
    {
      delay: Math.max(0, runAt - Date.now()),
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    }
  );
  return job;
}

export async function removePublishJob(jobId) {
  if (!jobId) return;
  const job = await publishingQueue.getJob(jobId);
  if (job) await job.remove();
}
