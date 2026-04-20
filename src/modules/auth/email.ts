import nodemailer from "nodemailer";
import { env } from "../../config/env";

function verificationBaseUrl() {
  return env.FRONTEND_URL ?? "http://localhost:3000";
}

export async function sendVerificationEmail(email: string, token: string, pendingPlanCode?: string) {
  const { CONTACT_FROM_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, CONTACT_TO_EMAIL } = env;

  if (!CONTACT_FROM_EMAIL || !SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return { sent: false, reason: "Email not configured" };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const verificationUrl = `${verificationBaseUrl().replace(/\/$/, "")}/verify?token=${encodeURIComponent(
    token
  )}${pendingPlanCode ? `&planCode=${encodeURIComponent(pendingPlanCode)}` : ""}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0f172a;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Talexia</h1>
            <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;">Email Verification</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <p style="margin:0 0 20px;color:#1e293b;font-size:16px;">Hi there,</p>
            <p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.6;">
              Confirm your email address to finish setting up your Talexia account.
            </p>
            ${pendingPlanCode
      ? `<p style="margin:0 0 24px;color:#475569;font-size:14px;line-height:1.6;">
              Selected Plan: <strong>${pendingPlanCode}</strong>
            </p>`
      : ""}
            <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td><a href="${verificationUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Verify Email</a></td>
              </tr>
            </table>
            <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;line-height:1.6;">
              If the button does not work, copy this link and open it in your browser:
            </p>
            <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;word-break:break-all;">${verificationUrl}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Talexia. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: CONTACT_FROM_EMAIL,
    to: email, // send to the user
    subject: "Verify your Talexia account",
    text: `Confirm your email to finish setting up your Talexia account.\n\nVerify: ${verificationUrl}\n\nIf you didn't request this, you can ignore it.`,
    html,
    ...(CONTACT_TO_EMAIL ? { bcc: CONTACT_TO_EMAIL } : {}),
  });

  return { sent: true };
}

export async function sendEnterprisePlanInviteEmail(params: {
  email: string;
  token: string;
  planCode: string;
  planName?: string;
  amount?: number;
  billingCycle?: "monthly" | "yearly";
  fullName?: string;
  companyName?: string;
}) {
  const { CONTACT_FROM_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, CONTACT_TO_EMAIL } = env;

  if (!CONTACT_FROM_EMAIL || !SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return { sent: false, reason: "Email not configured" };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const inviteUrl = `${verificationBaseUrl().replace(/\/$/, "")}/enterprise-plan/accept?token=${encodeURIComponent(
    params.token
  )}`;
  const recipientName = params.fullName || "there";
  const quotedAmount = typeof params.amount === "number"
    ? params.amount.toFixed(2)
    : null;
  const billingCycleLabel = params.billingCycle === "yearly" ? "Yearly" : "Monthly";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:#0f172a;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Talexia</h1>
            <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;">Enterprise Plan Invitation</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <p style="margin:0 0 20px;color:#1e293b;font-size:16px;">Hi ${recipientName},</p>
            <p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:1.6;">
              You have been invited to activate a custom Talexia Enterprise plan.
            </p>
            <p style="margin:0 0 8px;color:#475569;font-size:14px;line-height:1.6;"><strong>Plan Code:</strong> ${params.planCode}</p>
            ${params.planName ? `<p style="margin:0 0 8px;color:#475569;font-size:14px;line-height:1.6;"><strong>Plan Name:</strong> ${params.planName}</p>` : ""}
            ${quotedAmount ? `<p style="margin:0 0 8px;color:#475569;font-size:14px;line-height:1.6;"><strong>Quoted Price:</strong> $${quotedAmount} / ${billingCycleLabel.toLowerCase()}</p>` : ""}
            ${params.companyName ? `<p style="margin:0 0 24px;color:#475569;font-size:14px;line-height:1.6;"><strong>Company:</strong> ${params.companyName}</p>` : "<div style=\"height:16px\"></div>"}
            <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td><a href="${inviteUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">View Enterprise Plan</a></td>
              </tr>
            </table>
            <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;line-height:1.6;">If the button does not work, copy and open this link:</p>
            <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;word-break:break-all;">${inviteUrl}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Talexia. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: CONTACT_FROM_EMAIL,
    to: params.email,
    subject: "Your Talexia Enterprise Plan Is Ready",
    text: `You have been invited to activate a custom Talexia Enterprise plan (${params.planCode}).\n\nOpen: ${inviteUrl}`,
    html,
    ...(CONTACT_TO_EMAIL ? { bcc: CONTACT_TO_EMAIL } : {}),
  });

  return { sent: true };
}

export async function sendInvoiceEmail(
  email: string,
  invoiceNumber: string,
  amountPaid: string,
  hostedInvoiceUrl?: string,
  invoicePdfUrl?: string,
  extra?: {
    planName?: string;
    billingCycle?: string;
    userName?: string;
    date?: string;
    customerEmail?: string;
    invoiceStatus?: string;
    subtotalAmount?: string;
    taxAmount?: string;
    transactionId?: string;
  },
) {
  const { CONTACT_FROM_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env;

  if (!CONTACT_FROM_EMAIL || !SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return { sent: false, reason: "Email not configured" };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const greeting = extra?.userName ? `Hi ${extra.userName},` : "Hi there,";
  const invoiceDate = extra?.date ?? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const planLabel = extra?.planName ? extra.planName.replace(/_/g, " ") : "Subscription";
  const cycleLabel = extra?.billingCycle ?? "Monthly";
  const statusLabel = extra?.invoiceStatus ?? "Paid";
  const customerEmail = extra?.customerEmail ?? email;
  const subtotalAmount = extra?.subtotalAmount ?? amountPaid;
  const taxAmount = extra?.taxAmount ?? "0.00";
  const transactionId = extra?.transactionId ?? "N/A";
  const downloadUrl = invoicePdfUrl || hostedInvoiceUrl;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#0f172a;padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Talexia</h1>
            <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;">Payment Confirmed</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 32px;">
            <p style="margin:0 0 24px;color:#1e293b;font-size:16px;">${greeting}</p>
            <p style="margin:0 0 32px;color:#475569;font-size:15px;line-height:1.6;">
              Thank you! Your payment has been successfully processed. Here are your invoice details:
            </p>
            <!-- Invoice table -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;margin-bottom:32px;">
              <tr style="background:#f8fafc;">
                <td style="padding:12px 16px;color:#64748b;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0;">INVOICE NUMBER</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0;text-align:right;">${invoiceNumber}</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Date</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${invoiceDate}</td>
              </tr>
              <tr style="background:#f8fafc;">
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Plan</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${planLabel} (${cycleLabel})</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Customer Email</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${customerEmail}</td>
              </tr>
              <tr style="background:#f8fafc;">
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Payment Status</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${statusLabel}</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Transaction ID</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">${transactionId}</td>
              </tr>
              <tr style="background:#f8fafc;">
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Subtotal</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">$${subtotalAmount}</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;">Tax</td>
                <td style="padding:12px 16px;color:#1e293b;font-size:13px;border-bottom:1px solid #e2e8f0;text-align:right;">$${taxAmount}</td>
              </tr>
              <tr>
                <td style="padding:16px 16px;color:#1e293b;font-size:15px;font-weight:700;">Amount Paid</td>
                <td style="padding:16px 16px;color:#0f172a;font-size:18px;font-weight:700;text-align:right;">$${amountPaid}</td>
              </tr>
            </table>
            <!-- CTA buttons -->
            ${downloadUrl
      ? `<table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
              <tr>
                <td><a href="${downloadUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Download Invoice</a></td>
              </tr>
            </table>`
      : ""}
            <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
              If you have any questions about this invoice, please contact our support team.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">© ${new Date().getFullYear()} Talexia. All rights reserved.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textLines = [
    greeting,
    "",
    `Your Talexia subscription payment of $${amountPaid} has been received.`,
    `Invoice: ${invoiceNumber}`,
    `Date: ${invoiceDate}`,
    `Plan: ${planLabel} (${cycleLabel})`,
    `Customer Email: ${customerEmail}`,
    `Payment Status: ${statusLabel}`,
    `Transaction ID: ${transactionId}`,
    `Subtotal: $${subtotalAmount}`,
    `Tax: $${taxAmount}`,
  ];
  if (downloadUrl) textLines.push(`Download Invoice: ${downloadUrl}`);

  await transporter.sendMail({
    from: CONTACT_FROM_EMAIL,
    to: email,
    subject: `Talexia Invoice ${invoiceNumber} – Payment Confirmed`,
    text: textLines.join("\n"),
    html,
  });

  return { sent: true };
}
