# VidWiz Backend

## Purpose
Describe the FastAPI backend: structure, auth rules, and the request/worker lifecycle.

## Structure
- **App factory**: `backend/src/main.py` configures the FastAPI app and routers.
- **Settings**: `backend/src/config.py` (DB, JWT, OAuth, AWS, queues). Conversation settings live in `backend/src/conversations/config.py` (OpenRouter, quotas, S3).
- **Domains**: `auth`, `videos`, `notes`, `conversations`, `internal` follow `models/schemas/service/router/dependencies`.
- **ASGI entrypoint**: `backend/wsgi.py`.

## Auth & Access
- **JWT**: Required for most `/v2` endpoints.
- **Long-term tokens**: Only allowed for `POST /v2/videos/{video_id}/notes`.
- **Guest sessions**: `X-Guest-Session-ID` enables Wiz chat without a JWT.
- **Admin token**: Required for `/v2/internal/*` endpoints.
- **Signup defaults**: New users created via `POST /v2/auth/register` and first-time `POST /v2/auth/google` start with `profile_data.ai_notes_enabled = true`.
- **Secrets**: `SECRET_KEY` is required for JWT issuance and verification; missing it causes auth endpoints to return errors.
- **JWT expiry**: `JWT_EXPIRY_HOURS` controls JWT lifetime (default 24 hours).
- **Token payloads**: JWTs include `user_id`, `email`, `name`, `profile_image_url`, `exp`. Long-term tokens include `user_id`, `email`, `type=long_term`, and `iat` (no expiry).

## Validation Rules (Selected)
- **video_id**: Normalized from YouTube IDs or URLs; supports `youtube.com/watch`, `/shorts/`, `/live/`, `/embed/`, and `youtu.be`. Playlist URLs are rejected.
- **timestamp**: Must include `:` and at least two digits.
- **Note text**: Empty/whitespace text is normalized to `null`.
- **Chat message**: Must be non-empty after trimming.
- **Transcript payload**: Items must be dicts containing at least `text`.

## Key Behavior
- **Video lookup**: `GET /v2/videos/{video_id}` is JWT-only but is not scoped to the user; it returns the video if it exists.
- **Video list**: `GET /v2/videos` returns only videos that have notes for the authenticated user (join on notes).
- **Video search**: `q` is trimmed; queries shorter than 2 chars are treated as empty. Sort keys: `created_at_desc|created_at_asc|title_asc|title_desc`. `per_page` defaults to 10, max 50.
- **Video stream**: `GET /v2/videos/{video_id}/stream` requires JWT or guest session. The video is not user-scoped for either viewers or guests.
- **Notes**: List/edit/delete require JWT; create accepts JWT or long-term token.
- **Create note by title**: `POST /v2/notes/by-title` resolves the provided title against YouTube Data API v3, picks the top video result, then reuses normal note creation.
  - Requires `YOUTUBE_DATA_API_KEY` only when this endpoint is used.
- **Task scheduling**: Creating a note or conversation upserts the video and schedules transcript/metadata tasks when missing.
- **AI notes**: Enqueued only when note text is empty, AI notes are enabled, and the transcript is already available.
  - Enqueue uses the required `SQS_AI_NOTE_QUEUE_URL`.
- **Wiz quotas**: Daily message limits enforced separately for users and guests via `WIZ_USER_DAILY_QUOTA` and `WIZ_GUEST_DAILY_QUOTA`.
- **Wiz token budget**: `WIZ_MAX_TOKENS` (default 4096) controls the max completion tokens per Wiz response. Should be set higher for reasoning models that consume tokens on internal thinking.

## Async + Workers Integration
- **Tasks**: Metadata/transcript tasks are stored in the `tasks` table and polled via `/v2/internal/tasks`.
- **Task polling**: `/v2/internal/tasks?type=transcript|metadata` blocks up to a configurable timeout and returns `204` when no work is available.
- **Task lifecycle**: On claim, a task is marked `in_progress`, `started_at` is set, and `retry_count` increments. Stale `in_progress` tasks can be reclaimed after a timeout.
- **Transcript storage**: Transcripts are written to S3 when `S3_TRANSCRIPT_BUCKET_NAME` is configured, using the application's required AWS credentials; `transcript_available` is still set when the bucket is not configured.
- **Wiz chat**: Requires S3 transcript access and `OPENROUTER_API_KEY`. If transcript is not ready, `POST /v2/conversations/{id}/messages` returns `202 Accepted` with `status=processing`. If the transcript flag is set but S3 data is missing, the request errors with `Transcript data missing`.

## Streaming (SSE)
- **Video readiness**: `/v2/videos/{id}/stream` emits `snapshot`, `update`, and `done` when metadata, transcript, and summary are all ready (timeout 60s).
- **Wiz responses**: `/v2/conversations/{id}/messages` emits JSON SSE data with a
  `type` discriminator: `text`, `citation`, `done`, or `error`. Each text event
  contains a complete Markdown part. Citations contain `chunk_id`,
  `start_seconds`, and `end_seconds` resolved by FastAPI. `done` includes the
  persisted `message_id`; failures end with `error` and a safe `message`.
  There is no `[DONE]` sentinel. EOF without a terminal event is interruption.

### Wiz structured responses

OpenRouter receives a strict JSON schema for an ordered `parts` array. Text
parts contain complete Markdown blocks; citation parts from the model contain
only a chunk ID. Requests require a provider supporting structured outputs.
FastAPI incrementally frames complete JSON objects, validates them, resolves
references, and streams each part. It validates the full envelope and checks
successful model completion before saving. Invalid references are omitted and
logged; malformed or truncated output ends with an error. Already emitted parts
remain visible in the client but failed partial assistant responses are not saved.

Wiz normalizes existing transcript segments at read time. IDs combine a SHA-256
transcript revision prefix with the original segment index. They remain stable
for the same transcript snapshot. Start times use `offset`; end times use
`offset + duration`. Missing duration uses the next later valid offset, or the
start time if none exists. Invalid timing leaves text in context without a
citable ID. Fractional seconds are preserved. S3 objects and workers are unchanged.

Completed assistant parts are stored in message metadata as `parts_version=1`
and `parts`. The existing `content` column contains text parts joined by blank
lines. Message reads expose typed `parts`; older messages become one text part
without inferred citations. Follow-up model context retains structured parts,
but discards IDs absent from the current transcript. Stored citation timestamps
remain unchanged when a transcript is replaced.

Backend and frontend releases must be coordinated because this replaces the
previous string-only SSE contract. No database migration or transcript backfill
is needed. Smoke-test the configured OpenRouter model with this schema before
release; unsupported endpoints fail rather than falling back to plain text.

## Wiz Starter Questions
- `VideoRead.suggested_questions` exposes only the validated question list; the
  complete `miscellaneous_data` object is not part of the public API.
- Videos without generated questions return `suggested_questions=null` and
  retain the existing metadata + transcript + summary readiness rules.
- The internal summary write accepts summary text plus nested miscellaneous
  data and shallow-merges it into the existing object. Unrelated top-level keys
  are preserved, duplicate top-level keys are overwritten, and nested objects
  are replaced rather than recursively merged.

## Error Shape
- API errors are normalized to `{"error": {"code", "message", "details"}}` for handled exceptions.
## Response Conventions
- Datetimes are serialized as `YYYY-MM-DDTHH:MM:SS±HHMM` (local timezone offset).

## Data Model (Core Tables)
- **users**: Email/password or Google login; stores `long_term_token` and `profile_data`.
- **videos**: Metadata JSON, `transcript_available`, optional `summary`, and
  general-purpose `miscellaneous_data` JSON. Wiz starter questions are stored
  under `miscellaneous_data.suggested_questions`.
- **notes**: Timestamped notes tied to `videos.video_id` and a `user_id` (user foreign key is not enforced at the DB layer).
- **conversations/messages**: Threaded chat history per video; supports guest sessions.
- **tasks**: Internal work queue with `task_details`, `worker_details`, and retry metadata.

## Public API Surface (By Domain)
### Auth
- `POST /v2/auth/register`, `POST /v2/auth/login`, `POST /v2/auth/google`
- `POST /v2/auth/tokens`, `DELETE /v2/auth/tokens`
- `GET /v2/users/me`, `PATCH /v2/users/me`

### Videos
- `GET /v2/videos` (list/search)
- `GET /v2/videos/{video_id}`
- `GET /v2/videos/{video_id}/stream`

### Notes
- `GET /v2/videos/{video_id}/notes`
- `POST /v2/videos/{video_id}/notes`
- `POST /v2/notes/by-title`
- `PATCH /v2/notes/{note_id}`
- `DELETE /v2/notes/{note_id}`

### Conversations
- `POST /v2/conversations`
- `GET /v2/conversations/{id}`
- `GET /v2/conversations/{id}/messages`
- `POST /v2/conversations/{id}/messages` (SSE)

### Internal
- `GET /v2/internal/tasks`
- `POST /v2/internal/tasks/{id}/result`
- `GET /v2/internal/videos/{video_id}/ai-notes`
- `POST /v2/internal/videos/{video_id}/transcript`
- `POST /v2/internal/videos/{video_id}/metadata`
- `POST /v2/internal/videos/{video_id}/summary`
- `GET /v2/internal/videos/{video_id}`
- `PATCH /v2/internal/notes/{note_id}`

### Payments
- `GET /v2/payments/products`
- `POST /v2/payments/checkout`
- `POST /v2/payments/webhooks/dodo`

## Operational Notes
- The generated OpenAPI schema is available at `/openapi.json` and interactive
  Swagger UI is available at `/docs` in every environment. ReDoc is disabled.
- Swagger includes public, internal, and payment webhook routes. Protected
  operations still require their existing JWT, guest-session, or admin
  credentials.
- SQLite is the default when `DB_URL` is not set; Postgres is used in deployed environments.
- CORS allows all origins with credentials enabled and exposes `X-Request-ID`
  and `Retry-After` to browser clients; browsers will reject credentialed
  requests with wildcard origins.
- Rate limiting uses SlowAPI with an in-memory store by default and IP-only keys.
  - Env vars: `RATE_LIMIT_ENABLED`, `RATE_LIMIT_DEFAULT`, `RATE_LIMIT_AUTH`, `RATE_LIMIT_CONVERSATIONS`, `RATE_LIMIT_VIDEOS`.
  - `/v2/internal/*` endpoints are exempt.
- Prometheus metrics are exposed at `GET /v2/internal/metrics` and require the admin token.

## Logging
- API requests log a single structured entry with request/response metadata.
- `X-Request-ID` is generated if missing and echoed in responses.
- Request/response bodies are logged for JSON/text content types, redacted and truncated.
- Logging skips the metrics endpoint and Loki excludes `/v2/internal/tasks`.
- Log output includes endpoint name and source location when resolvable.
- Severity mapping: `INFO` for 2xx/3xx, `WARNING` for 4xx, `ERROR` for 5xx.
- Truncation defaults: 8KB for request bodies and 8KB for response bodies.
- Redaction applies to: `password`, `token`, `access_token`, `refresh_token`, `long_term_token`, `authorization`, `secret`, `api_key`, `key`, `cookie`, `set-cookie`, `session`, `csrf`, `jwt`.
- Default JSON fields include (when available):
  - `timestamp`, `level`, `logger`, `message`, `request_id`
  - `http_method`, `http_path`, `http_query`, `http_status`, `duration_ms`
  - `client_ip`, `user_agent`
  - `endpoint`, `endpoint_source`
  - `request_content_type`, `request_body`, `request_body_bytes`, `request_body_truncated`
  - `response_content_type`, `response_body`, `response_body_bytes`, `response_content_length`, `response_body_truncated`
- `client_ip` extraction precedence matches rate limiting: `X-Forwarded-For` (first IP), then `X-Real-IP`, then socket client host.
- Stdout is pretty-printed for readability; Loki receives JSON.
- Configure Loki via:
  - `LOKI_URL` (Grafana Cloud Loki push URL)
  - `LOKI_USERNAME`, `LOKI_PASSWORD`
  - Optional: `LOG_LEVEL`, `LOG_SERVICE_NAME`

## Startup Requirements
The server fails on startup if any of the following env vars are missing:
- `ENVIRONMENT`
- `SECRET_KEY`
- `VIDWIZ_INTERNAL_API_ADMIN_TOKEN`
- `GOOGLE_CLIENT_ID`
- `SQS_AI_NOTE_QUEUE_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DODO_PAYMENTS_API_KEY`
- `DODO_PAYMENTS_WEBHOOK_KEY`
- `DODO_PAYMENTS_ENVIRONMENT`
- `DODO_PAYMENTS_RETURN_URL`
- `DODO_CREDIT_PRODUCTS`
