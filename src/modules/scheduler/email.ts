import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

type SchedulerEmailPayload = {
  to: string;
  subject: string;
  body: string;
};

function buildTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

export async function sendSchedulerEmail(payload: SchedulerEmailPayload) {
  const transporter = buildTransporter();
  if (!transporter || !env.CONTACT_FROM_EMAIL) {
    return { sent: false, reason: "Email not configured" };
  }

  try {
    await transporter.sendMail({
      from: env.CONTACT_FROM_EMAIL,
      to: payload.to,
      subject: payload.subject,
      text: payload.body,
    });
    return { sent: true };
  } catch (error) {
    logger.error("Scheduler email send failed", {
      to: payload.to,
      subject: payload.subject,
      error,
    });
    return { sent: false, reason: "Email sending failed" };
  }
}
