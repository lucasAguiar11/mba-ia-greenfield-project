---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-03
scope_description: "Upload of files up to 10GB without blocking the API, background video processing (metadata extraction + thumbnail generation), unique video URLs, and streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend delivers the entire phase: video module, object storage integration, background queue, worker process, migration, and all video endpoints (upload init, processing, streaming, download).
- `next-frontend/` — explicitly out of scope for this phase. Per the challenge brief: *"Este é um desafio de backend: a entrega é a API, o worker, a infraestrutura e os artefatos do processo. (Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase.)"* No open decision in this document.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan explicitly leaves this "TBD" — it is the one genuinely open stack decision of the phase (object storage is already fixed to S3/MinIO per the challenge brief). The queue decouples video upload completion from processing (metadata extraction, thumbnail generation), which must not block the HTTP request/response cycle. The current stack has PostgreSQL 17 already running; it has neither Redis nor RabbitMQ.

**Options:**

### Option A: BullMQ (`bullmq` + `@nestjs/bullmq`) on Redis
- Redis-backed queue. `@nestjs/bullmq` gives first-class NestJS integration (`@Processor` decorated classes, DI). Retries use built-in `attempts` + `backoff: { type: 'exponential', delay }` per job or as a queue default (confirmed via BullMQ docs).
- **Pros:** Best-documented NestJS integration among the three. Lowest latency/highest throughput. Exponential backoff is a one-line config, not custom code.
- **Cons:** Introduces Redis as a brand-new infrastructure dependency — a new service in `compose.yaml`, a new failure mode to operate (persistence config, memory limits), for a single job type (video processing) that does not need Redis-grade throughput.

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq`)
- AMQP broker. NestJS integration via `@RabbitSubscribe` decorators and `AmqpConnection.publish()`. Dead-lettering is a native broker feature (`deadLetterExchange` on queue args), but **retry-with-limit is not automatic** — the consumer must read/set an `x-retry-count` header itself and return `Nack(true)` to requeue or `Nack(false)` to dead-letter (confirmed via `@golevelup/nestjs-rabbitmq` docs).
- **Pros:** Most robust and standard broker for pub/sub-heavy architectures; native DLQ semantics at the broker level.
- **Cons:** Heaviest infra addition (exchanges, bindings, its own admin UI); retry-with-limit requires hand-rolled header bookkeeping instead of a config flag. No messaging need elsewhere in the project to justify the operational cost for a single job type.

### Option C: pg-boss (Postgres-backed queue)
- Uses the already-running PostgreSQL 17 as the queue backend (`SKIP LOCKED`-based polling) — zero new infrastructure. `createQueue()` supports `retryLimit`, `retryDelay`, `retryBackoff` (exponential), and a `deadLetter` queue name with `redrive()` to replay dead-lettered jobs, all as native, declarative options (confirmed via pg-boss docs) — feature parity with BullMQ's retry/backoff for this phase's needs.
- **Pros:** No new service in `compose.yaml` — the queue lives in the database already backing the app. Retry, backoff, and DLQ are declarative, not hand-rolled. Transactional guarantees inherited from Postgres.
- **Cons:** No official NestJS module — relies on a community wrapper (e.g., `@wisemen/pgboss-nestjs-job`) or a thin custom provider, lower adoption than `@nestjs/bullmq`. Throughput is bound by Postgres polling, adequate for a single video-processing queue but not for high-volume messaging.

**Recommendation:** **Option C (pg-boss)** — the project's only job type in this phase is "process one uploaded video," at a volume nowhere near what would strain Postgres-backed polling. Adding Redis or RabbitMQ purely to run one queue is infrastructure the phase does not need yet; pg-boss's native retry/backoff/DLQ already match BullMQ's feature set for this use case, at zero new `compose.yaml` services. If a second, high-throughput job type appears in a later phase, BullMQ + Redis can be introduced then with justification.

**Decision:** A (BullMQ + Redis)

**Note:** Decision deliberately diverged from the Recommendation. The target architecture (C4 diagram) models the Message Queue as a **dedicated container** separate from the Database, and the challenge's deliverable structure lists queue infrastructure as its own `compose.yaml` service alongside storage and worker ("`compose.yaml ← + storage, fila, worker`"), with "fila, worker e storage reais subindo no Compose" as an explicit acceptance criterion. pg-boss would collapse the queue into the existing Postgres container — sound engineering, but divergent from the architecture this phase is expected to materialize. BullMQ + Redis keeps the queue as a first-class Compose service and uses the best-documented NestJS integration (`@nestjs/bullmq`), at the acceptable cost of one small additional infrastructure service.

---

## TD-02: Large Video Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must reach object storage without ever fully transiting through — or blocking — the NestJS process. A single presigned `PutObject` is not viable on its own: S3-compatible single-PUT uploads cap at 5GB, below the 10GB requirement, so any presigned-URL approach for this phase must use the multipart upload API. Depends on TD-03 (bucket/key layout) for where the object lands.

**Options:**

### Option A: Presigned multipart upload, direct client → MinIO
- The API creates the draft video row, calls `CreateMultipartUploadCommand`, and returns a presigned URL per part (`UploadPartCommand` + `getSignedUrl`, confirmed via AWS SDK v3 docs) for the client to `PUT` each chunk directly to MinIO. The client reports part ETags back; the API calls `CompleteMultipartUploadCommand` to finalize, then enqueues the processing job.
- **Pros:** Zero video bytes touch the NestJS process — API load is O(1) regardless of file size or concurrent uploads. Parts can be retried/resumed individually on network failure. Matches the architecture diagram's explicit `frontend → storage` relationship.
- **Cons:** More orchestration endpoints (initiate, per-part sign, complete, abort) than a single upload route. Client is responsible for chunking and retrying parts.

### Option B: Streaming proxy through the API
- Client sends the file as a single multipart/form-data (or raw stream) request to the API; the API streams it through to MinIO via `@aws-sdk/lib-storage`'s `Upload` helper without buffering the whole file in memory.
- **Pros:** Single upload endpoint, simplest client implementation.
- **Cons:** Every uploaded byte still occupies an API HTTP connection and Node event-loop attention for the full transfer duration — concurrent large uploads scale linearly against API resources, which is exactly what the phase's "sem travar o sistema" requirement warns against. No native chunk-level resume: a dropped connection restarts the whole 10GB transfer.

### Option C: Resumable protocol (tus)
- Adopt the [tus](https://tus.io) resumable upload protocol via a self-hosted `tusd` or a Node tus-server component, which accepts chunked uploads with pause/resume support, then moves the completed file to MinIO as a separate step.
- **Pros:** Purpose-built for resumable large uploads; strong client library ecosystem.
- **Cons:** Introduces a whole new server component absent from the architecture diagram, plus a second copy step (tus's local/interim storage → MinIO) that duplicates storage I/O for every upload. Solves a problem (resumability) that multipart presigned URLs already solve using infrastructure already in the plan (S3/MinIO).

**Recommendation:** **Option A (Presigned multipart upload)** — it is the only option where API resource usage is independent of file size and concurrent upload count, directly satisfying "upload de até 10GB sem impacto na performance." It reuses the object storage already decided for the phase instead of adding a new server component (unlike Option C), and avoids the linear-scaling API load of Option B.

**Decision:** A (Presigned multipart upload)

**Note (implementation constraint for planning):** SigV4 presigned URLs embed the request host in the signature. URLs signed against the Compose-internal endpoint (`http://minio:9000`) are only valid from inside the Docker network; a client on the host machine needs URLs signed against the publicly reachable endpoint (e.g., `http://localhost:9000`). The S3 client configuration must therefore distinguish an **internal endpoint** (worker/API/integration tests) from a **public endpoint** (presign operations for external clients) — two env vars, one signing client per purpose. This constraint applies equally to TD-06's presigned GET URLs.

---

## TD-03: Object Storage Bucket & Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage technology itself is fixed (S3-compatible, MinIO locally). What remains open is how buckets and object keys are organized — this is a cross-component contract: it shapes the video entity's stored-key columns, what the worker writes back after processing, and how the streaming/download endpoints resolve an object. Depends on TD-05 (public identifier) for what the key is keyed by.

**Options:**

### Option A: Single bucket, type-prefixed keys
- One `streamtube` bucket. Keys follow `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to create/configure/back up. Prefix-based listing is trivial if ever needed. Matches the single-bucket simplicity of a self-hosted MinIO instance.
- **Cons:** Mixed asset types share a bucket-level policy/lifecycle configuration — acceptable for this phase, but a future phase wanting different retention or CDN rules per asset type would need to re-key.

### Option B: Separate buckets per asset type
- Two buckets: `videos` (originals) and `thumbnails`. Keys are simply `{videoId}.<ext>` within each.
- **Pros:** Independent lifecycle/policy configuration per asset type from day one (e.g., different cache headers for thumbnails vs. videos later).
- **Cons:** Two buckets to provision in `compose.yaml`/MinIO init instead of one, for a benefit (per-bucket policy) this phase does not yet need.

**Recommendation:** **Option A (single bucket, type-prefixed keys)** — the phase has no requirement demanding different storage policies per asset type; one bucket keeps MinIO provisioning to a single step, and the `videos/{videoId}/...` prefix already gives clean separation between originals and thumbnails without the operational overhead of a second bucket.

**Decision:** A (Single bucket, type-prefixed keys)

---

## TD-04: Video Processing Worker — Execution Model & Media Tooling

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram names a dedicated "Video Worker (FFmpeg)" container consuming jobs from the queue, reading/writing object storage, and updating the database. Two things need deciding together: where the worker's code lives (same NestJS codebase vs. a separate script) and how it invokes FFmpeg/ffprobe — the two are coupled because the execution model determines what's available for the FFmpeg call (DI, config, TypeORM entities).

**Options:**

### Option A: Standalone NestJS application in the same project
- A second entrypoint (e.g., `src/worker/main.ts`, run via `NestFactory.createApplicationContext`) inside `nestjs-project/`, reusing the same TypeORM entities, `@nestjs/config` setup, and the queue module from TD-01. FFmpeg/ffprobe are invoked directly via `child_process.spawn` (`ffprobe -print_format json` for metadata, `ffmpeg -ss ... -vframes 1` for the thumbnail frame) — no wrapper library.
- **Pros:** Zero duplication of DB connection, config, or entity definitions — the worker is a thin consumer around code the API already has. `child_process.spawn` avoids depending on `fluent-ffmpeg`, which is **archived since May/2025** and no longer receives compatibility fixes for current FFmpeg releases.
- **Cons:** The worker's Docker image needs the `ffmpeg` binary installed (extra `apt-get install ffmpeg` layer or a dedicated Dockerfile), on top of Node — a second, heavier image than the API's.

### Option B: Standalone plain Node.js script (no NestJS)
- A minimal script with its own lightweight DB client and queue consumer, invoking FFmpeg the same way (`child_process.spawn`), but without instantiating Nest's DI container.
- **Pros:** Smaller runtime footprint, faster cold start — irrelevant for a long-running worker process.
- **Cons:** Duplicates config loading, DB connection setup, and (partially) entity/type definitions that already exist in the NestJS app, with no corresponding benefit since the worker is a long-lived process, not a cold-start-sensitive one.

**Recommendation:** **Option A (standalone NestJS app, `child_process.spawn` for FFmpeg)** — reusing the existing TypeORM entities, config module, and TD-01 queue module avoids duplicating connection/config code that Option B would require rewriting. Invoking `ffmpeg`/`ffprobe` directly sidesteps depending on an archived wrapper library for the phase's core processing logic.

**Decision:** A (Standalone NestJS app + `child_process.spawn`)

**Note (deployment shape):** regardless of sharing the codebase, the worker runs as a **separate `compose.yaml` service** with its own container (own `command` targeting the worker entrypoint, own Docker image layer with the `ffmpeg` binary installed) — matching the C4 diagram's dedicated "Video Worker (FFmpeg)" container and the challenge's requirement that the worker rises via `docker compose` alongside the backend. Same codebase, two containers: `nestjs-api` and `video-worker`.

---

## TD-05: Public Video Identifier / Unique URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a public-facing identifier for its URL, guaranteed unique. Prior phases already use UUID primary keys (`uuid_generate_v4()`) for `users` and `channels`, established in the Phase 01/02 migrations.

**Options:**

### Option A: Reuse the entity's UUID primary key
- The video's `id` (UUID v4, generated the same way as `users.id`/`channels.id`) is the identifier used directly in URLs (`/videos/{id}`, `/videos/{id}/stream`).
- **Pros:** Zero extra work — no new column, no new library. Collision probability is already negligible (UUIDv4). Consistent with the identifier convention every existing entity in the project already follows.
- **Cons:** UUIDs are long (36 chars) and not visually friendly in a URL — a purely cosmetic concern, since the phase does not require short/pretty URLs.

### Option B: Separate short opaque slug (nanoid)
- Add a second column (e.g., 10-12 char nanoid) generated at video creation, used in public URLs instead of the UUID PK, decoupling the internal identifier from the public-facing one.
- **Pros:** Shorter, more shareable URLs. Internal PK stays hidden from clients.
- **Cons:** New dependency (`nanoid`), new unique-indexed column, and a second identifier to keep in sync with the PK everywhere the video is referenced — for a requirement ("URL única, sem conflito") that Option A already satisfies with no new code.

**Recommendation:** **Option A (reuse the UUID primary key)** — the capability only asks for uniqueness and no-conflict, both of which the existing UUID convention already guarantees. Introducing a second identifier column and a new dependency would add a maintenance surface (two IDs per video) with no requirement driving it. As a side benefit, UUIDs are non-guessable — groundwork for Phase 05's unlisted-videos-via-direct-link capability.

**Decision:** A (Reuse UUID primary key)

---

## TD-06: Video Delivery Strategy (Streaming & Download)

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Both streaming playback and full download need to serve potentially multi-gigabyte files without the API process becoming the bottleneck. The architecture diagram already models a **direct** relationship — `Rel(frontend, storage, "Streams", "HTTPS")` — separate from the `frontend → api` REST relationship, which is a strong signal for where the bytes should flow.

**Options:**

### Option A: Presigned GET URLs, direct client ↔ storage
- The API returns a short-lived presigned `GetObjectCommand` URL (via `getSignedUrl`, same mechanism as TD-02's upload) for the video object. The client's `<video>` element or browser download uses that URL directly against MinIO, which natively honors `Range` headers and returns `206 Partial Content` — no custom range-handling code needed. Download reuses the same presigned URL with a `ResponseContentDisposition: attachment` parameter.
- **Pros:** Matches the architecture diagram's direct frontend↔storage relationship exactly. API bandwidth/CPU usage is independent of how many videos are being streamed concurrently — MinIO serves the bytes. Range/206 support is native to the storage layer, zero custom code.
- **Cons:** The presigned URL's expiry window must be tuned so long-playback sessions don't hit an expired URL mid-stream (mitigated with a generous expiry, e.g., a few hours). Requires MinIO's endpoint to be reachable from the client's network, not just from the API's Docker network (a `compose.yaml`/env concern, not a code concern).

### Option B: API-proxied streaming
- The API reads the client's `Range` header, issues a ranged `GetObjectCommand` to MinIO, and pipes the resulting stream back to the client with a hand-rolled `206 Partial Content` response.
- **Pros:** All storage access stays behind the API; storage credentials and endpoint never reach the client.
- **Cons:** Every streamed/downloaded byte flows through the API process — the exact bottleneck the phase's "sem travar o sistema" concern targets, this time for playback instead of upload. Requires hand-written range-parsing and partial-content logic that MinIO already provides for free.

**Recommendation:** **Option A (Presigned GET URLs)** — it is the only option consistent with the architecture diagram's direct `frontend → storage` streaming relationship, and it delegates 206/Range handling to MinIO instead of reimplementing it in the API. Bandwidth for potentially many concurrent video streams never touches the NestJS process.

**Decision:** A (Presigned GET URLs)

**Note:** the dual-endpoint constraint documented in TD-02 (internal vs. public signing endpoint for SigV4) applies identically here — presigned GET URLs handed to external clients must be signed against the publicly reachable MinIO endpoint.

---

## TD-07: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The video row is pre-created as a draft the moment upload begins (before any bytes finish transferring), then transitions through processing states as the upload completes and the worker (TD-04) runs. The project plan's own "Pontos de Atenção" section names the states verbatim: *"status (ex.: rascunho → processando → pronto/erro)"*. What failure handling looks like when the worker's job errors out is not specified and depends on TD-01's queue capabilities (retry/backoff/DLQ).

**Options:**

### Option A: Minimal 4-state machine — `draft → processing → ready | error`
- `draft`: row created at upload initiation, before the file is confirmed uploaded. `processing`: multipart upload completed, job enqueued/picked up by the worker. `ready`: worker finished successfully (metadata + thumbnail persisted). `error`: worker exhausted its retries (per TD-01's retry limit) without succeeding; an `error_reason` column records the last failure for diagnostics.
- **Pros:** Matches the exact wording already given in the project plan — no invented states. Small, easy-to-test state machine (4 states, 3 transitions). Retry policy is entirely TD-01's queue configuration (BullMQ `attempts` + `backoff`), not extra application code.
- **Cons:** No distinct "upload in progress" vs. "upload complete, queued" states — a client polling status sees `draft` for the whole upload+queue-wait window.

### Option B: Extended state machine with upload/queue granularity
- Adds `uploaded` (multipart completed, not yet enqueued) and `queued` (accepted by the broker, not yet picked up by the worker) between `draft` and `processing`.
- **Pros:** Finer-grained status for a client polling upload progress.
- **Cons:** Two more states and transitions to persist, test, and keep consistent with the queue's actual internal state — for a UI-progress benefit that has no driving requirement in this phase (the frontend video interface is explicitly out of scope).

**Recommendation:** **Option A (minimal 4-state machine)** — it is literally the state set the project plan names, and the phase has no frontend surface to consume finer-grained intermediate states (Option B's benefit). Failure handling composes with whatever retry/backoff TD-01's chosen queue technology provides natively, rather than adding custom retry-counting logic in the application layer.

**Decision:** A (Minimal 4-state machine — `draft → processing → ready | error`)

**Note (to pin during plan-build):** the exact trigger of the `draft → processing` transition must be specified in the plan — it happens at the multipart-complete endpoint (when the API confirms the upload and enqueues the job), not at worker pickup, so a video whose job is still queued already reads `processing`.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | C (pg-boss) | A (BullMQ + Redis) — diverged; see Note |
| TD-02 | Backend | Large Video Upload Strategy | A (Presigned multipart upload) | A (Presigned multipart upload) |
| TD-03 | Backend | Object Storage Bucket & Key Organization | A (Single bucket, type-prefixed keys) | A (Single bucket, type-prefixed keys) |
| TD-04 | Backend | Video Processing Worker — Execution Model & Media Tooling | A (Standalone NestJS app + `child_process.spawn`) | A (Standalone NestJS app + `child_process.spawn`) |
| TD-05 | Backend | Public Video Identifier / Unique URL Strategy | A (Reuse UUID primary key) | A (Reuse UUID primary key) |
| TD-06 | Backend | Video Delivery Strategy (Streaming & Download) | A (Presigned GET URLs) | A (Presigned GET URLs) |
| TD-07 | Backend | Video Status Lifecycle & Failure Handling | A (Minimal 4-state machine) | A (Minimal 4-state machine) |

---

## Research Methodology Note

TD-01 (BullMQ retry/backoff, pg-boss queue/retry/DLQ API), TD-02/TD-03 (AWS SDK v3 `CreateMultipartUploadCommand`/`UploadPartCommand`/presigned URLs, custom-endpoint support for MinIO), and the RabbitMQ retry-header pattern cited in TD-01 were verified against official documentation via **context7** (library IDs: `/taskforcesh/bullmq`, `/timgit/pg-boss`, `/aws/aws-sdk-js-v3`, `/websites/golevelup_github_io_nestjs_modules_rabbitmq`). The `fluent-ffmpeg` maintenance-status claim in TD-04 (archived since May/2025) was confirmed via web search, since library-repository archival status is not the kind of fact a documentation snapshot reliably surfaces.
