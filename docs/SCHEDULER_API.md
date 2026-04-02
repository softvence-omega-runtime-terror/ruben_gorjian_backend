<<<<<<< HEAD
# Unified Scheduler API

Base paths:

- `/scheduler`
- `/api/scheduler`

One scheduler domain, two flows:

- Posting flow (`scheduleType=POSTING`)
- Session flow (`scheduleType=PHOTO_SESSION | VIDEO_SESSION`)

Calendly and video checkout are intentionally not included in this phase.

## 1) Create posting schedule

`POST /scheduler/posts`  
Content-Type: `multipart/form-data`

Form fields:

- `data` (required JSON string)
- `files` (optional, repeatable)

`data` JSON:

```json
{
  "userId": "optional_client_id_for_admin",
  "caption": "A timeless bridal pairing",
  "hashtags": ["diamond", "bridal"],
  "cta": "Book now",
  "shortDescription": "Campaign item",
  "scheduledAt": "2026-05-17T14:27:00+06:00",
  "socialAccountIds": ["social_1", "social_2"],
  "adminReason": "optional admin note"
}
```

Behavior:

- backend uploads files to S3 if provided
- creates asset rows
- links assets to post
- creates post targets for selected social accounts
- enqueues publish job to Redis/BullMQ with delay until `scheduledAt`

## 2) Update posting schedule

`PATCH /scheduler/posts/:id`

```json
{
  "caption": "Updated caption",
  "scheduledAt": "2026-05-18T16:30:00+06:00",
  "socialAccountIds": ["social_1"],
  "adminReason": "Moved after review"
}
```

## 3) Posting publish status (admin/super-admin)

`PATCH /scheduler/posts/:id/publish-status`

Completed:

```json
{
  "status": "completed",
  "adminReason": "Published from admin dashboard"
}
```

Failed:

```json
{
  "status": "failed",
  "failureReason": "Platform token expired",
  "adminReason": "Need reconnect"
}
```

## 4) Create session booking

`POST /scheduler/sessions`  
Content-Type: `application/json`

```json
{
  "userId": "optional_client_id_for_admin",
  "scheduleType": "PHOTO_SESSION",
  "scheduledAt": "2026-05-20T11:00:00+06:00",
  "sessionTitle": "May photoshoot",
  "sessionNotes": "Need white background product shots",
  "sessionDurationMinutes": 60,
  "adminReason": "optional admin note"
}
```

Rules:

- must have active subscription
- plan must allow selected session type
- session quota per billing period must allow booking

## 5) Update session booking

`PATCH /scheduler/sessions/:id`

```json
{
  "scheduledAt": "2026-05-21T12:00:00+06:00",
  "sessionTitle": "Rescheduled photoshoot",
  "sessionNotes": "Updated shot list",
  "sessionDurationMinutes": 90,
  "adminReason": "Client requested change"
}
```

## 6) Session status (admin/super-admin only)

`PATCH /scheduler/sessions/:id/status`

Completed:

```json
{
  "status": "completed",
  "adminReason": "Session done"
}
```

Failed:

```json
{
  "status": "failed",
  "sessionFailureReason": "Client no-show",
  "adminReason": "Reschedule required"
}
```

Canceled:

```json
{
  "status": "canceled",
  "adminReason": "Client requested cancellation"
}
```

## 7) Calendly resync (admin/super-admin only)

`POST /scheduler/sessions/:id/calendly-resync`

No body.

Use this when a session has `calendly.syncStatus = FAILED` and you want to retry manually.

## 8) Delete schedule item

`DELETE /scheduler/posts/:id`

Works for both posting and session records.

## 9) Get single schedule item

`GET /scheduler/posts/:id`

Response contains:

- `scheduleType`
- posting fields and targets (for posting)
- `session` object (for sessions)
- `session.calendly` sync object for sessions:
  - `syncStatus` (`PENDING|SYNCED|FAILED`)
  - `eventUri`
  - `inviteeUri`
  - `syncError`
  - `lastSyncedAt`
- `schedulerStatus` (`pending|completed|failed`)

## 10) Unified list/calendar with pagination

`GET /scheduler/posts`

Query params:

- `view=day|week|month|list`
- `date=YYYY-MM-DD`
- `from=ISO_DATETIME`
- `to=ISO_DATETIME`
- `status=draft|scheduled|publishing|posted|failed`
- `scheduleType=posting|photo_session|video_session`
- `sessionStatus=booked|completed|failed|canceled`
- `calendlySyncStatus=pending|synced|failed`
- `failure=true|false`
- `platform=instagram|facebook|linkedin`
- `userId=<clientId>` (admin only)
- `page=1`
- `pageSize=20`

Response:

- `items`
- `filters`
- `meta` with:
  - `count`
  - `totalCount`
  - `page`
  - `pageSize`
  - `totalPages`
  - `hasNextPage`
  - `hasPreviousPage`

## Status mapping

For UI:

- posting: derived from post status
- sessions:
  - `BOOKED` => `schedulerStatus=pending`
  - `COMPLETED` => `schedulerStatus=completed`
  - `FAILED` or `CANCELED` => `schedulerStatus=failed`

## Plan entitlement fields (DB)

Added to `Plan`:

- `photoSessionEnabled`
- `videoSessionEnabled`
- `photoSessionsPerPeriod`
- `videoSessionsPerPeriod`

## Session email + sync behavior

- Session create/update/status APIs trigger email notifications (client + admins) when SMTP is configured.
- Calendly sync is non-blocking:
  - API success does not depend on Calendly success.
  - Sync result is stored in session calendly fields and post events.
  - Calendly sync is enqueued to Redis/BullMQ per booking lifecycle action (create/reschedule/cancel) with retry.
  - If Redis is unavailable, backend falls back to inline Calendly sync.
  - Non-retriable Calendly 4xx errors (except 429) are marked failed without queue retry storm.
=======
# Unified Scheduler API

Base paths:
- `/scheduler`
- `/api/scheduler`

One scheduler domain, two flows:
- Posting flow (`scheduleType=POSTING`)
- Session flow (`scheduleType=PHOTO_SESSION | VIDEO_SESSION`)

Calendly and video checkout are intentionally not included in this phase.

## 1) Create posting schedule

`POST /scheduler/posts`  
Content-Type: `multipart/form-data`

Form fields:
- `data` (required JSON string)
- `files` (optional, repeatable)

`data` JSON:
```json
{
  "userId": "optional_client_id_for_admin",
  "caption": "A timeless bridal pairing",
  "hashtags": ["diamond", "bridal"],
  "cta": "Book now",
  "shortDescription": "Campaign item",
  "scheduledAt": "2026-05-17T14:27:00+06:00",
  "socialAccountIds": ["social_1", "social_2"],
  "adminReason": "optional admin note"
}
```

Behavior:
- backend uploads files to S3 if provided
- creates asset rows
- links assets to post
- creates post targets for selected social accounts

## 2) Update posting schedule

`PATCH /scheduler/posts/:id`
```json
{
  "caption": "Updated caption",
  "scheduledAt": "2026-05-18T16:30:00+06:00",
  "socialAccountIds": ["social_1"],
  "adminReason": "Moved after review"
}
```

## 3) Posting publish status (admin/super-admin)

`PATCH /scheduler/posts/:id/publish-status`

Completed:
```json
{
  "status": "completed",
  "adminReason": "Published from admin dashboard"
}
```

Failed:
```json
{
  "status": "failed",
  "failureReason": "Platform token expired",
  "adminReason": "Need reconnect"
}
```

## 4) Create session booking

`POST /scheduler/sessions`  
Content-Type: `application/json`

```json
{
  "userId": "optional_client_id_for_admin",
  "scheduleType": "PHOTO_SESSION",
  "scheduledAt": "2026-05-20T11:00:00+06:00",
  "sessionTitle": "May photoshoot",
  "sessionNotes": "Need white background product shots",
  "sessionDurationMinutes": 60,
  "adminReason": "optional admin note"
}
```

Rules:
- must have active subscription
- plan must allow selected session type
- session quota per billing period must allow booking

## 5) Update session booking

`PATCH /scheduler/sessions/:id`
```json
{
  "scheduledAt": "2026-05-21T12:00:00+06:00",
  "sessionTitle": "Rescheduled photoshoot",
  "sessionNotes": "Updated shot list",
  "sessionDurationMinutes": 90,
  "adminReason": "Client requested change"
}
```

## 6) Session status (admin/super-admin only)

`PATCH /scheduler/sessions/:id/status`

Completed:
```json
{
  "status": "completed",
  "adminReason": "Session done"
}
```

Failed:
```json
{
  "status": "failed",
  "sessionFailureReason": "Client no-show",
  "adminReason": "Reschedule required"
}
```

Canceled:
```json
{
  "status": "canceled",
  "adminReason": "Client requested cancellation"
}
```

## 7) Delete schedule item

`DELETE /scheduler/posts/:id`

Works for both posting and session records.

## 8) Get single schedule item

`GET /scheduler/posts/:id`

Response contains:
- `scheduleType`
- posting fields and targets (for posting)
- `session` object (for sessions)
- `schedulerStatus` (`pending|completed|failed`)

## 9) Unified list/calendar with pagination

`GET /scheduler/posts`

Query params:
- `view=day|week|month|list`
- `date=YYYY-MM-DD`
- `from=ISO_DATETIME`
- `to=ISO_DATETIME`
- `status=draft|scheduled|publishing|posted|failed`
- `scheduleType=posting|photo_session|video_session`
- `sessionStatus=booked|completed|failed|canceled`
- `failure=true|false`
- `platform=instagram|facebook|linkedin`
- `userId=<clientId>` (admin only)
- `page=1`
- `pageSize=20`

Response:
- `items`
- `filters`
- `meta` with:
  - `count`
  - `totalCount`
  - `page`
  - `pageSize`
  - `totalPages`
  - `hasNextPage`
  - `hasPreviousPage`

## Status mapping

For UI:
- posting: derived from post status
- sessions:
  - `BOOKED` => `schedulerStatus=pending`
  - `COMPLETED` => `schedulerStatus=completed`
  - `FAILED` or `CANCELED` => `schedulerStatus=failed`

## Plan entitlement fields (DB)

Added to `Plan`:
- `photoSessionEnabled`
- `videoSessionEnabled`
- `photoSessionsPerPeriod`
- `videoSessionsPerPeriod`
>>>>>>> 69614fc10aa539c6720f9e149fe53393ddf0bacd
