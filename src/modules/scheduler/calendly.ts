import { env } from "../../config/env";

export type SchedulerCalendlyAction = "create" | "reschedule" | "cancel";

export type SchedulerCalendlyPayload = {
  action: SchedulerCalendlyAction;
  sessionId: string;
  scheduleType: "POSTING" | "PHOTO_SESSION" | "VIDEO_SESSION";
  scheduledAt: string;
  durationMinutes: number | null;
  title: string | null;
  notes: string | null;
  status: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  admin: {
    id: string;
    email: string;
    name: string | null;
  } | null;
};

type CalendlySyncResult = {
  eventUri: string | null;
  inviteeUri: string | null;
  raw: unknown;
};

function extractString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractCalendlyUris(data: any) {
  return {
    eventUri:
      extractString(data?.eventUri) ??
      extractString(data?.event_uri) ??
      extractString(data?.event?.uri) ??
      null,
    inviteeUri:
      extractString(data?.inviteeUri) ??
      extractString(data?.invitee_uri) ??
      extractString(data?.invitee?.uri) ??
      null,
  };
}

export async function syncSchedulerSessionToCalendly(
  payload: SchedulerCalendlyPayload
): Promise<CalendlySyncResult> {
  if (!env.CALENDLY_API_ENDPOINT) {
    throw new Error("Calendly endpoint is not configured");
  }

  const response = await fetch(env.CALENDLY_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.CALENDLY_API_TOKEN ? { Authorization: `Bearer ${env.CALENDLY_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      source: "talexia-scheduler",
      ...payload,
    }),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const details = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Calendly sync failed (${response.status}): ${details || "Unknown response"}`);
  }

  const { eventUri, inviteeUri } = extractCalendlyUris(data);
  return {
    eventUri,
    inviteeUri,
    raw: data,
  };
}
