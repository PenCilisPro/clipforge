import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.js";

const connection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Queue names must match the backend producer exactly.
export const pipelineQueue = new Queue("clipforge-pipeline", { connection });

export async function enqueuePipeline(name, data, opts = {}) {
  return pipelineQueue.add(name, data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
    ...opts,
  });
}
