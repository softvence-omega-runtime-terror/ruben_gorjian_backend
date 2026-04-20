# Talexia Backend API Reference

This document is a frontend-oriented reference for the current backend routes mounted in [`src/app.ts`](/d:/Project/ruben_gorjian_backend/src/app.ts).

It is based on the live router configuration and request validation schemas in the repo as of today.

## Base URL and route mounts

- Local backend base URL: `http://localhost:4000`
- Some modules are mounted under multiple prefixes:
  - Billing:
    - `/billing`
    - `/api/billing`
  - Social:
    - `/social`
    - `/api/social`
  - Admin:
    - `/admin`
    - `/api/admin`

## Auth model

- Main auth style: JWT stored in `httpOnly` cookie named `token`
- Frontend should send requests with credentials enabled
  - `fetch(..., { credentials: "include" })`
- Some routes also support Bearer auth through middleware fallback, but cookie auth is the main model

## Common response conventions

- Validation errors usually return:
  ```json
  {
    "error": "Invalid payload",
    "details": { "...": "..." }
  }
  ```
- Success often returns either:
  - `{ success: true }`
  - or a resource object such as `{ user: ... }`, `{ post: ... }`, `{ quote: ... }`

## Core enums

### Roles

- `USER`
- `ADMIN`
- `SUPER_ADMIN`

### UserStatus

- `ACTIVE`
- `BLOCKED`
- `DELETED`

### SubscriptionStatus

- `INCOMPLETE`
- `ACTIVE`
- `PAST_DUE`
- `CANCELED`
- `TRIALING`

### BillingCycle

- `MONTHLY`
- `YEARLY`

Frontend payload values currently used by billing endpoints:

- `monthly`
- `yearly`

### PriceType

- `STANDARD`
- `FOUNDER`

### AddonType

- `RECURRING`
- `ONE_TIME`

### BillingQuoteStatus

- `PENDING`
- `CHECKOUT_CREATED`
- `COMPLETED`
- `EXPIRED`
- `CANCELED`

### PlanCategory

- `CALENDAR_ONLY`
- `VISUAL_ADD_ON`
- `VISUAL_CALENDAR`
- `FULL_MANAGEMENT`
- `JEWELRY_CALENDAR_ONLY`
- `JEWELRY_VISUAL`
- `JEWELRY_FULL_MANAGEMENT`

### SocialPlatform

- `INSTAGRAM`
- `FACEBOOK`
- `LINKEDIN`

### PostStatus

- `DRAFT`
- `SCHEDULED`
- `PUBLISHING`
- `POSTED`
- `FAILED`

### PostTargetStatus

- `PENDING`
- `SCHEDULED`
- `POSTED`
- `FAILED`

### ProviderRoutingMode

- `AUTO`
- `FORCE_NATIVE`
- `FORCE_UPLOAD_POST`

### NotificationType

- `SUBMISSION_CREATED`
- `SUBMISSION_STATUS_UPDATED`
- `ENHANCED_DELIVERY_SENT`
- `ADMIN_POST_CREATED`
- `ADMIN_POST_PUBLISHED`
- `ADMIN_POST_FAILED`

### AssetType

- `IMAGE`
- `VIDEO`

### AssetKind

- `ORIGINAL`
- `ENHANCED`

### AssetSource

- `USER_UPLOAD`
- `ADMIN_UPLOAD`

### SubmissionStatus

- `DRAFT`
- `SUBMITTED`
- `IN_REVIEW`
- `ENHANCED_SENT`
- `NEEDS_CHANGES`
- `COMPLETED`
- `REJECTED`
- `CLOSED`

### SubmissionPlanCategory

- `FULL_MANAGEMENT`
- `VISUAL_ONLY`

## Route index

- Auth
- Billing
- Uploads
- AI captions
- Social
- Posts
- Admin
- Admin posting/media
- Notifications
- Contact
- Onboarding
- Brand
- Dashboard
- Settings
- Submissions
- Admin submissions
- Visits
- Debug
- Upload-Post provider
- SMTP test

---

## Auth

Base path: `/auth`

### POST `/auth/signup`

Create a user account with a preselected plan.

Request body:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "pendingPlanCode": "FMP-20"
}
```

Notes:
- `pendingPlanCode` is required
- returns `201`
- does not issue login session yet until email is verified

Success response:
```json
{
  "message": "Account created. Check your email to verify.",
  "requiresVerification": true
}
```

### POST `/auth/login`

Login for normal users.

Request body:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Success:
- sets `token` cookie
- returns safe user object

### POST `/auth/admin/login`

Login for `ADMIN` or `SUPER_ADMIN`.

Same request body as `/auth/login`.

### POST `/auth/logout`

Clears auth cookie.

Response:
```json
{ "success": true }
```

### GET `/auth/me`

Auth required.

Returns current authenticated user plus lightweight subscription state.

### POST `/auth/request-password-reset`

Request body:
```json
{
  "email": "user@example.com"
}
```

### POST `/auth/reset-password`

Request body:
```json
{
  "token": "reset-token",
  "password": "newpassword123"
}
```

### POST `/auth/google`

Request body:
```json
{
  "idToken": "google-id-token",
  "pendingPlanCode": "FMP-20"
}
```

### POST `/auth/google/callback`

Request body:
```json
{
  "code": "oauth-code",
  "pendingPlanCode": "FMP-20"
}
```

### POST `/auth/verify-email`

Request body:
```json
{
  "token": "email-verification-token"
}
```

### POST `/auth/resend-verification`

Request body:
```json
{
  "email": "user@example.com"
}
```

### GET `/auth/enterprise-invite/validate`

Query params:
- `token`

Validates enterprise invite token, marks invite as viewed, and returns invite + plan preview payload.

### POST `/auth/signup-enterprise-invite`

Signup from invite token (signup first, payment later flow).

Request body:
```json
{
  "token": "enterprise-invite-token",
  "password": "StrongPass123!",
  "name": "Client Name"
}
```

---

## Billing

Base paths:
- `/billing`
- `/api/billing`

### GET `/billing/catalog`

Primary pricing/catalog endpoint for frontend.

Returns:
- plans
- billing options
- active terms for each plan
- available add-ons

### GET `/billing/terms/:planCode`

Returns all active terms for a plan.

### POST `/billing/quote`

Auth required.

Request body:
```json
{
  "planCode": "FMP-20",
  "billingCycle": "monthly",
  "termsVersionIds": ["term_id_1", "term_id_2"],
  "additionalPlatformQty": 2
}
```

Validation:
- `termsVersionIds` minimum 1
- all term IDs must belong to the selected plan
- all term IDs must be active and not deleted
- `additionalPlatformQty` min `0`, max `10`

### GET `/billing/plans`

Legacy pricing endpoint. Still usable, but `/billing/catalog` is the better frontend source.

### POST `/billing/checkout`

Auth required.

Request body:
```json
{
  "quoteId": "quote_id"
}
```

### POST `/billing/visual-topups/checkout`

Auth required.

Request body:
```json
{
  "quantity": 1,
  "successUrl": "https://app.example.com/success",
  "cancelUrl": "https://app.example.com/cancel"
}
```

### POST `/billing/video-session/checkout`

Auth required.

Request body:
```json
{
  "hours": 2,
  "reference": "appointment_123",
  "successUrl": "https://app.example.com/success",
  "cancelUrl": "https://app.example.com/cancel"
}
```

### POST `/billing/portal`

Auth required.

### POST `/billing/sync`

Auth required. Rate limited.

### GET `/billing/summary`

Auth required.

### GET `/billing/invoices`

Auth required.

### POST `/billing/webhook`

Stripe webhook endpoint. Frontend should not call this.

---

## Uploads

Base path: `/uploads`

### POST `/uploads/presign`

Auth required.

Request body:
```json
{
  "fileName": "image.png",
  "contentType": "image/png",
  "fileSize": 102400,
  "purpose": "asset"
}
```

`purpose`:
- `asset`
- `avatar`

### POST `/uploads/asset`

Auth required.

Request body:
```json
{
  "storageKey": "user/123/image.png",
  "contentType": "image/png",
  "type": "IMAGE",
  "kind": "ORIGINAL"
}
```

### GET `/uploads/assets`

Auth required.

---

## AI

Base path: `/ai`

### POST `/ai/captions`

Auth required.

Request body:
```json
{
  "assetId": "asset_id",
  "style": "storytelling",
  "platforms": ["INSTAGRAM"]
}
```

`style`:
- `storytelling`
- `design-focused`
- `minimalist`

### GET `/ai/content/:contentItemId`

Auth required.

### POST `/ai/caption`

Auth required.

Request body:
```json
{
  "assetId": "asset_id",
  "brandProfileId": "optional"
}
```

---

## Social

Base paths:
- `/social`
- `/api/social`

### GET `/social`

Auth required.

### POST `/social/connect`

Auth required.

Request body:
```json
{
  "platform": "INSTAGRAM"
}
```

Allowed `platform` values:
- `INSTAGRAM`
- `FACEBOOK`
- `LINKEDIN`

### GET `/social/callback/upload-post`

Upload-Post callback endpoint.

### GET `/social/callback/:platform`

Native OAuth callback endpoint.

### POST `/social/disconnect`

Auth required.

Request body:
```json
{
  "socialAccountId": "social_account_id"
}
```

### POST `/social/refresh/:socialAccountId`

Auth required.

---

## Posts

Base path: `/posts`

### GET `/posts`

Auth required.

Query params:
- `cursor`
- `limit`
- `status`
- `q`

### GET `/posts/calendar`

Auth required.

Query params:
- `startDate`
- `endDate`

### GET `/posts/:postId`

Auth required.

### POST `/posts`

Auth required.

Request body:
```json
{
  "assetId": "optional",
  "assetIds": ["optional"],
  "contentItemId": "optional",
  "caption": "Post caption",
  "hashtags": ["tag1", "tag2"],
  "scheduledFor": "2026-03-28T10:00:00.000Z",
  "platforms": ["INSTAGRAM", "FACEBOOK"],
  "socialAccountIds": ["social_account_id"]
}
```

### PUT `/posts/:postId`

Auth required.

### DELETE `/posts/:postId`

Auth required.

### POST `/posts/:postId/schedule`

Auth required.

### POST `/posts/:postId/publish`

Auth required.

### GET `/posts/due`

Auth + admin required.

### GET `/posts/:postId/errors`

Auth required.

### GET `/posts/calendar/enhanced`

Auth required.

### POST `/posts/:postId/duplicate`

Auth required.

### PUT `/posts/:postId/move`

Auth required.

### POST `/posts/find-slot`

Auth required.

### GET `/posts/statistics`

Auth required.

### PUT `/posts/bulk/status`

Auth required.

### POST `/posts/recurring`

Auth required.

---

## Admin

Base paths:
- `/admin`
- `/api/admin`

All admin routes require:
- authenticated user
- admin role

### GET `/admin/summary`

Returns high-level counts.

### GET `/admin/users`

Query params:
- `search`
- `role`: `USER | ADMIN | SUPER_ADMIN`
- `status`: `ACTIVE | BLOCKED | DELETED`
- `plan`
- `founder`: `true | false`
- `subscriptionStatus`: `ACTIVE | TRIALING | PAST_DUE | CANCELED | INCOMPLETE`
- `sortBy`: `createdAt | periodEnd | founder | plan`
- `sortDir`: `asc | desc`
- `page`
- `pageSize` max `50`

### POST `/admin/users`

Request body:
```json
{
  "name": "Optional",
  "email": "user@example.com",
  "role": "USER",
  "planCode": "FMP-20",
  "sendVerification": true
}
```

### GET `/admin/users/:id`

Returns:
- user
- profile
- brandProfile
- subscriptions
- posts
- usageSummary

### GET `/admin/users/:id/publishing-routing`

### GET `/admin/publishing-routing/global`

### PUT `/admin/publishing-routing/global`

Request body:
```json
{
  "mode": "FORCE_NATIVE",
  "applyTo": "USERS_ONLY",
  "useInstagram": true,
  "useFacebook": true,
  "useLinkedin": true
}
```

### PUT `/admin/users/:id/publishing-routing`

Request body:
```json
{
  "mode": "FORCE_NATIVE",
  "useInstagram": true,
  "useFacebook": true,
  "useLinkedin": true
}
```

### PATCH `/admin/users/:id`

Request body:
```json
{
  "name": "Optional",
  "role": "ADMIN"
}
```

### DELETE `/admin/users/:id`

Soft delete user. Cannot delete self.

### POST `/admin/users/:id/delete-with-password`

Request body:
```json
{
  "password": "admin-password"
}
```

### GET `/admin/users/:id/scheduled-items`

Query params:
- `page`
- `pageSize`
- `status`: `DRAFT | SCHEDULED | PUBLISHING | POSTED | FAILED`

### POST `/admin/users/:id/block`

Request body:
```json
{
  "reason": "Reason text"
}
```

### POST `/admin/users/:id/unblock`

No body.

### POST `/admin/users/:id/resend-verification`

Optional header:
- `idempotency-key`

### POST `/admin/users/:id/cancel-subscription`

Request body:
```json
{
  "cancelAtPeriodEnd": true
}
```

### POST `/admin/users/:id/refresh-subscription`

Manual Stripe sync for a user subscription.

### GET `/admin/users/:id/invoices`

### GET `/admin/users/:id/audit-logs`

### POST `/admin/users/:id/reset-password`

Request body:
```json
{
  "password": "new-password"
}
```

### GET `/admin/subscriptions`

### POST `/admin/enterprise-plan/invites`

Create and send an enterprise invite email for signup-before-payment flow.

Request body:
```json
{
  "planName": "Enterprise Growth",
  "companyName": "Omega Holdings",
  "fullName": "Client Name",
  "email": "client@example.com",
  "socialPlatforms": ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
  "reelsPerMonth": 20,
  "microReelsPerMonth": 30,
  "proPhotoShootFrequency": "Monthly",
  "proPhotoShootLength": "4 hours",
  "captionHashtags": true,
  "scheduling": true,
  "amount": 1250,
  "billingCycle": "MONTHLY",
  "expiresInDays": 7
}
```

Notes:
- `planCode` is auto-generated by backend in `ENT_XXXXXXXX` format.
- `amount` is in USD dollars (not cents).

### GET `/admin/enterprise-plan/invites`

Query params:
- `status`: `PENDING | VIEWED | SIGNED_UP | PAYMENT_COMPLETED | EXPIRED | CANCELED`
- `search`
- `page`
- `pageSize`

### GET `/admin/enterprise-plan/invites/:id/details`

Returns a complete enterprise invite snapshot:
- invite lifecycle fields
- proposal pricing/status fields
- linked user (if signup completed)
- latest subscription for this invite plan

### POST `/admin/enterprise-plan/invites/:id/resend`

Refreshes token, extends expiry, and resends invite email.

### PATCH `/admin/enterprise-plan/invites/:id/cancel`

Cancels an unused invite.

### DELETE `/admin/enterprise-plan/invites/:id/permanent`

Permanently deletes enterprise invite + proposal data.
If the generated enterprise plan has never been used by subscriptions/terms/quotes, it is also removed.

### GET `/admin/calendars`

### GET `/admin/plan-terms`

### POST `/admin/plan-terms`

Request body:
```json
{
  "planCode": "FMP-20",
  "version": "main-v1",
  "title": "Main Terms",
  "content": "Full terms content",
  "isActive": true
}
```

### PATCH `/admin/plan-terms/:id`

Request body:
```json
{
  "title": "Updated title",
  "content": "Updated content"
}
```

### POST `/admin/plan-terms/:id/status`

Request body:
```json
{
  "isActive": false
}
```

### DELETE `/admin/plan-terms/:id`

Soft delete plan terms.

### GET `/admin/addons`

### POST `/admin/addons`

Request body:
```json
{
  "code": "VIDEO_SESSION",
  "name": "Video Session",
  "description": "Video production add-on",
  "type": "ONE_TIME",
  "isActive": true,
  "monthlyUnitAmountCents": 49500,
  "yearlyUnitAmountCents": 49500
}
```

### PATCH `/admin/addons/:id`

Request body:
```json
{
  "name": "Updated name",
  "description": "Updated description",
  "monthlyUnitAmountCents": 500,
  "yearlyUnitAmountCents": 4800
}
```

### POST `/admin/addons/:id/status`

Request body:
```json
{
  "isActive": true
}
```

### DELETE `/admin/addons/:id`

Soft delete add-on.

---

## Admin posting and media

Base paths:
- `/admin`
- `/api/admin`

All routes require:
- auth
- admin post permission middleware

### POST `/admin/users/:userId/posts`

Request body:
```json
{
  "content": {
    "caption": "Caption",
    "hashtags": ["tag1"],
    "cta": "Optional",
    "shortDescription": "Optional"
  },
  "mediaIds": ["asset_id"],
  "platforms": ["INSTAGRAM"],
  "socialAccountIds": ["social_account_id"],
  "publishMode": "NOW",
  "scheduledFor": "2026-03-28T10:00:00.000Z",
  "timezone": "Asia/Dhaka",
  "reason": "Why admin is posting"
}
```

`publishMode`:
- `NOW`
- `SCHEDULE`

### GET `/admin/users/:userId/posts`

Query params:
- `page`
- `pageSize`
- `status`

### POST `/admin/users/:userId/posts/:postId/cancel`

### POST `/admin/:userId/posts/:postId/approve`

### GET `/admin/users/:userId/connected-platforms`

### GET `/admin/users/:userId/media/debug`

### GET `/admin/users/:userId/media`

Query params:
- `type`: `IMAGE | VIDEO`
- `source`: `USER_UPLOAD | ADMIN_UPLOAD`
- `page`
- `pageSize`

### POST `/admin/users/:userId/media/upload-url`

Request body:
```json
{
  "filename": "image.png",
  "mimeType": "image/png",
  "size": 102400
}
```

### POST `/admin/users/:userId/media/:mediaId/finalize`

Request body:
```json
{
  "width": 1200,
  "height": 1200,
  "duration": 10
}
```

### DELETE `/admin/users/:userId/media/:mediaId`

### POST `/admin/users/:userId/posts/import-google-sheet`

Request body:
```json
{
  "sheetUrl": "https://docs.google.com/spreadsheets/..."
}
```

---

## Notifications

Base path: `/api/notifications`

### GET `/api/notifications`

Auth required.

Query params:
- `limit`
- `offset`

### GET `/api/notifications/unread-count`

Auth required.

### PATCH `/api/notifications/:id/read`

Auth required.

### POST `/api/notifications/mark-all-read`

Auth required.

---

## Contact

Base path: `/api/contact-submissions`

### POST `/api/contact-submissions`

Request body:
```json
{
  "fullName": "Name",
  "businessName": "Business",
  "email": "lead@example.com",
  "websiteOrHandle": "example.com",
  "interests": ["calendar", "full-management"],
  "postsPerMonth": "20",
  "message": "Optional",
  "source": "landing-page"
}
```

`interests` values:
- `calendar`
- `ai-visuals`
- `full-management`
- `guidance`

`postsPerMonth` values:
- `10`
- `20`
- `40`
- `60`
- `100`
- `not-sure`

### POST `/api/contact-submissions/newsletter`

Request body:
```json
{
  "email": "lead@example.com"
}
```

---

## Onboarding

Base path: `/onboarding`

All routes require auth.

### POST `/onboarding/calendar`

Request body:
```json
{
  "name": "User Name",
  "email": "optional@example.com",
  "platforms": ["INSTAGRAM"],
  "timezone": "Asia/Dhaka",
  "timezoneAutoDetect": false,
  "insightGoal": "STAY_CONSISTENT"
}
```

`insightGoal`:
- `STAY_CONSISTENT`
- `PLAN_AHEAD`
- `REDUCE_LAST_MINUTE`

### GET `/onboarding/calendar`

### POST `/onboarding/visual/draft`

Draft save for visual onboarding.

### POST `/onboarding/visual`

Final visual onboarding submit.

Important enum groups:

`industry`
- `RESTAURANT`
- `CAFE_COFFEE`
- `JEWELRY`
- `RUGS_HOME_DECOR`
- `APPAREL`
- `OTHER`

`targetAudience`
- `B2C`
- `B2B`

`salesModel`
- `RETAIL`
- `WHOLESALE`
- `BOTH`

`primaryPlatform`
- `INSTAGRAM`
- `FACEBOOK`
- `LINKEDIN`
- `WEBSITE`
- `ADS`

`ctaEmbedded`
- `YES`
- `NO`

`outlineFrame`
- `YES`
- `NO`

`brandVibe`
- `CLEAN_MINIMAL`
- `WARM_COZY`
- `BOLD_HIGH_CONTRAST`
- `PREMIUM_LUXURY`
- `NATURAL_LIFESTYLE`

`visualStylePreference`
- `REALISTIC`
- `SLIGHTLY_ENHANCED`
- `MARKETING_STYLE`

### GET `/onboarding/visual`

### POST `/onboarding/full-management/draft`

Draft save for full-management onboarding.

### POST `/onboarding/full-management`

Major fields:
- `businessName`
- `websiteUrl`
- `instagramUrl`
- `facebookUrl`
- `linkedinUrl`
- `platformsToManage`
- `postingAccessGranted`
- `industry`
- `targetAudience`
- `salesModel`
- `logoStorageKey`
- `brandPersonality`
- `toneToAvoid`
- `imageUsagePermission`
- `visualStylePreference`
- `outlineFrame`
- `allowCtas`
- `postingFrequencyPreference`
- `postingTimePreference`

### GET `/onboarding/full-management`

### POST `/onboarding/complete`

Legacy endpoint; marks onboarding complete.

---

## Brand

Base path: `/brand`

Auth required.

### POST `/brand`

Request body:
```json
{
  "industry": "Optional",
  "productTypes": "Optional",
  "businessType": "Optional",
  "tone": "Optional",
  "audience": "Optional",
  "competitors": "Optional",
  "ctaPreferences": "Optional",
  "hashtagPreferences": "Optional",
  "website": "Optional",
  "step": 1
}
```

### GET `/brand`

### POST `/brand/files`

Request body:
```json
{
  "storageKey": "brand/file.pdf",
  "fileName": "brand-guidelines.pdf",
  "fileType": "application/pdf"
}
```

### POST `/brand/files/download`

Request body:
```json
{
  "storageKey": "brand/file.pdf"
}
```

---

## Dashboard

Base path: `/dashboard`

Auth required.

### GET `/dashboard/overview`

Returns lightweight overview metrics and recent activity.

---

## Settings

Base path: `/user/settings`

Auth required.

### GET `/user/settings`

Returns current profile and business settings.

### PUT `/user/settings`
### PATCH `/user/settings`

Same payload shape for update:
```json
{
  "profile": {
    "fullName": "User Name",
    "bio": "Optional bio",
    "avatar": {
      "storageKey": "user/123/avatar.png",
      "contentType": "image/png",
      "remove": false
    }
  },
  "business": {
    "name": "Business Name",
    "website": "https://example.com",
    "industry": "Retail",
    "timezone": "Asia/Dhaka"
  }
}
```

### DELETE `/user/settings/photo`

Removes avatar only.

---

## Submissions

Base path: `/api/submissions`

Auth required plus visual submission access.

### GET `/api/submissions/quota`

Returns current visual submission quota snapshot.

### POST `/api/submissions`

Create submission and presigned upload URLs.

Request body:
```json
{
  "userNote": "Optional note",
  "files": [
    {
      "fileName": "image.png",
      "fileType": "image/png",
      "fileSize": 102400
    }
  ]
}
```

### POST `/api/submissions/:id/files/complete`

Request body:
```json
{
  "files": [
    {
      "fileName": "image.png",
      "fileType": "image/png",
      "fileSize": 102400,
      "storageKey": "submissions/user/file.png"
    }
  ]
}
```

### POST `/api/submissions/:id/presign-single`

Request body:
```json
{
  "files": [
    {
      "fileName": "image.png",
      "fileType": "image/png",
      "fileSize": 102400
    }
  ]
}
```

### GET `/api/submissions`

Query params:
- `limit`
- `offset`

### GET `/api/submissions/:id`

### GET `/api/submissions/:id/enhanced-deliveries`

### GET `/api/submissions/:id/enhanced-deliveries/:deliveryId/files/:fileId/download`

### GET `/api/submissions/:id/files/:fileId/download`

---

## Admin submissions

Base path: `/api/admin/submissions`

Auth + admin required.

### GET `/api/admin/submissions`

Query params:
- `status`
- `userId`
- `planCategory`
- `search`
- `sort`
- `order`
- `limit`
- `offset`

### GET `/api/admin/submissions/:id/enhanced-deliveries`

### POST `/api/admin/submissions/:id/enhanced-deliveries`

Request body:
```json
{
  "message": "Optional delivery message",
  "files": [
    {
      "fileName": "result.png",
      "mimeType": "image/png",
      "size": 102400
    }
  ]
}
```

### POST `/api/admin/submissions/:id/enhanced-deliveries/:deliveryId/complete`

Request body:
```json
{
  "files": [
    {
      "fileName": "result.png",
      "mimeType": "image/png",
      "size": 102400,
      "storageKey": "submissions/.../enhanced/..."
    }
  ]
}
```

### GET `/api/admin/submissions/:id`

### PATCH `/api/admin/submissions/:id`

Request body:
```json
{
  "status": "IN_REVIEW",
  "adminNote": "Optional admin note"
}
```

### GET `/api/admin/submissions/:id/files/:fileId/download`

---

## Visits

Base path: `/api/visits`

Auth required.

### GET `/api/visits/config`

Returns:
- `bookingUrl`
- `apiConfigured`

### POST `/api/visits/schedule`

Request body:
```json
{
  "scheduledAt": "2026-03-28T10:00:00.000Z",
  "timezone": "Asia/Dhaka",
  "notes": "Optional notes"
}
```

---

## Debug

Base path: `/api/debug`

Available only outside production.

### GET `/api/debug/subscription-status`

Auth required.

Returns current user subscription debugging payload.

---

## Upload-Post provider

Base path: `/api/providers/upload-post`

### GET `/api/providers/upload-post/health`

Auth + admin required.

Returns provider health status.

### POST `/api/providers/upload-post/webhook/:token`

Provider webhook.

Frontend should not call this.

---

## SMTP test

Base path: `/smtp-test`

### GET `/smtp-test`

Checks if SMTP host/port is reachable.

---

## Frontend implementation notes

### 1. Use credentials on all authenticated requests

Example:
```ts
fetch(`${API_BASE}/auth/me`, {
  credentials: "include"
})
```

### 2. Prefer these frontend sources of truth

- Pricing page:
  - `GET /billing/catalog`
- Current user:
  - `GET /auth/me`
- Current billing:
  - `GET /billing/summary`
- Social connections:
  - `GET /social`
- Notifications:
  - `GET /api/notifications`

### 3. Billing checkout flow

Recommended frontend order:

1. `GET /billing/catalog`
2. `GET /billing/terms/:planCode`
3. `POST /billing/quote`
4. `POST /billing/checkout`
5. redirect browser to returned `checkoutUrl`

### 4. Multiple terms acceptance

Frontend must submit:
- `termsVersionIds: string[]`

At least one term ID is required.

### 5. Additional Platform add-on

Frontend submits:
- `additionalPlatformQty`

This is quantity for the same recurring add-on, not a count of different add-on types.

### 6. Route aliases

When both `/billing/...` and `/api/billing/...` exist:
- pick one convention on frontend and stay consistent
- recommended: use `/billing` and `/social` if backend and frontend run on same origin/path assumptions
