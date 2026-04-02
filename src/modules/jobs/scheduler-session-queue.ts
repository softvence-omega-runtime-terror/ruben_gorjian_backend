import { JobsOptions, Queue, UnrecoverableError, Worker } from "bullmq";
import { getRedis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { SchedulerCalendlyAction } from "../scheduler/calendly";
import { performSessionCalendlySync } from "../scheduler/calendly-sync";

const redis = getRedis();

type SchedulerSessionSyncJob = {
  postId: string;
  action: SchedulerCalendlyAction;
};

export const schedulerSessionQueue =
  redis &&
  new Queue("scheduler-session-sync", {
    connection: redis as any,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

export function startSchedulerSessionQueueWorker(concurrency = 2) {
  if (!redis) {
    logger.warn("Redis not configured; scheduler session queue worker not started");
    return;
  }

  const worker = new Worker(
    "scheduler-session-sync",
    async (job) => {
      const payload = job.data as SchedulerSessionSyncJob;
      try {
        await performSessionCalendlySync(payload.postId, payload.action);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isNonRetriable4xx =
          /Calendly sync failed \((4\d\d)\):/i.test(message) && !/Calendly sync failed \(429\):/i.test(message);
        if (isNonRetriable4xx) {
          throw new UnrecoverableError(message);
        }
        throw error;
      }
      return { synced: true };
    },
    {
      connection: redis as any,
      concurrency,
    }
  );

  worker.on("completed", (job) => {
    logger.info("Scheduler session sync job completed", {
      id: job.id,
      postId: job.data?.postId,
      action: job.data?.action,
    });
  });

  worker.on("failed", (job, err) => {
    logger.error("Scheduler session sync job failed", {
      id: job?.id,
      postId: job?.data?.postId,
      action: job?.data?.action,
      error: err?.message || "Unknown error",
    });
  });

  logger.info("Scheduler session queue worker started");
}

export async function enqueueSchedulerSessionSync(
  postId: string,
  action: SchedulerCalendlyAction,
  opts?: JobsOptions
) {
  if (!schedulerSessionQueue) {
    logger.warn("Redis not configured; skipping scheduler session sync enqueue");
    return false;
  }

  await schedulerSessionQueue.add("session-sync", { postId, action }, opts);
  return true;
}
