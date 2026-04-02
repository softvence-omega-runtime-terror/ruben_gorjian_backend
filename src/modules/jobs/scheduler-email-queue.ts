import { JobsOptions, Queue, Worker } from "bullmq";
import { getRedis } from "../../lib/redis";
import { logger } from "../../lib/logger";
import { sendSchedulerEmail } from "../scheduler/email";

const redis = getRedis();

type SchedulerEmailJob = {
  to: string;
  subject: string;
  body: string;
  context?: string;
  postId?: string;
  action?: string;
};

export const schedulerEmailQueue =
  redis &&
  new Queue("scheduler-email", {
    connection: redis as any,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

export function startSchedulerEmailQueueWorker(concurrency = 3) {
  if (!redis) {
    logger.warn("Redis not configured; scheduler email queue worker not started");
    return;
  }

  const worker = new Worker(
    "scheduler-email",
    async (job) => {
      const payload = job.data as SchedulerEmailJob;
      const sent = await sendSchedulerEmail({
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
      });

      if (!sent.sent) {
        throw new Error(sent.reason || "Unknown email send failure");
      }

      return { sent: true };
    },
    {
      connection: redis as any,
      concurrency,
    }
  );

  worker.on("completed", (job) => {
    logger.info("Scheduler email job completed", {
      id: job.id,
      to: job.data?.to,
      subject: job.data?.subject,
      postId: job.data?.postId,
      action: job.data?.action,
      context: job.data?.context,
    });
  });

  worker.on("failed", (job, err) => {
    logger.error("Scheduler email job failed", {
      id: job?.id,
      to: job?.data?.to,
      subject: job?.data?.subject,
      postId: job?.data?.postId,
      action: job?.data?.action,
      context: job?.data?.context,
      error: err?.message || "Unknown error",
    });
  });

  logger.info("Scheduler email queue worker started");
}

export async function enqueueSchedulerEmail(
  data: SchedulerEmailJob,
  opts?: JobsOptions
) {
  if (!schedulerEmailQueue) {
    logger.warn("Redis not configured; skipping scheduler email enqueue", {
      to: data.to,
      subject: data.subject,
      postId: data.postId,
      action: data.action,
      context: data.context,
    });
    return false;
  }

  await schedulerEmailQueue.add("send-email", data, opts);
  logger.info("Scheduler email enqueued", {
    to: data.to,
    subject: data.subject,
    postId: data.postId,
    action: data.action,
    context: data.context,
  });
  return true;
}
