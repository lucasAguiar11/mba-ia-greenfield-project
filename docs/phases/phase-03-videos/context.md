---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-29T11:39:20-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T16:45:33-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-29T11:39:20-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-29T11:39:20-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-29T11:39:20-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-06-29T11:39:20-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-29T11:39:19-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None explicitly named in this phase block._ (Resolved by research/decisions: `nestjs-project/` — backend delivers the entire phase; `next-frontend/` explicitly out of scope per the challenge brief.)

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Processing Queue Technology | decided | A (BullMQ + Redis) | — |
| phase-03-videos/TD-02 | phase | Backend | Large Video Upload Strategy | decided | A (Presigned multipart upload) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Bucket & Key Organization | decided | A (Single bucket, type-prefixed keys) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Processing Worker — Execution Model & Media Tooling | decided | A (Standalone NestJS app + `child_process.spawn`) | — |
| phase-03-videos/TD-05 | phase | Backend | Public Video Identifier / Unique URL Strategy | decided | A (Reuse UUID primary key) | — |
| phase-03-videos/TD-06 | phase | Backend | Video Delivery Strategy (Streaming & Download) | decided | A (Presigned GET URLs) | — |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle & Failure Handling | decided | A (Minimal 4-state machine — `draft → processing → ready \| error`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the project's only job type in this phase is "process one uploaded video," at a volume nowhere near what would strain Postgres-backed polling. Adding Redis or RabbitMQ purely to run one queue is infrastructure the phase does not need yet; pg-boss's native retry/backoff/DLQ already match BullMQ's feature set for this use case, at zero new `compose.yaml` services. If a second, high-throughput job type appears in a later phase, BullMQ + Redis can be introduced then with justification.
**Libraries:** —

**Note:** Decision deliberately diverged from the Recommendation. The target architecture (C4 diagram) models the Message Queue as a dedicated container separate from the Database, and the challenge's deliverable structure lists queue infrastructure as its own `compose.yaml` service alongside storage and worker, with "fila, worker e storage reais subindo no Compose" as an explicit acceptance criterion. BullMQ + Redis keeps the queue as a first-class Compose service and uses the best-documented NestJS integration (`@nestjs/bullmq`).

### phase-03-videos/TD-02

**Recommendation:** it is the only option where API resource usage is independent of file size and concurrent upload count, directly satisfying "upload de até 10GB sem impacto na performance." It reuses the object storage already decided for the phase instead of adding a new server component (unlike Option C), and avoids the linear-scaling API load of Option B.
**Libraries:** —

**Note (implementation constraint):** SigV4 presigned URLs embed the request host in the signature. URLs signed against the Compose-internal endpoint (`http://minio:9000`) are only valid from inside the Docker network; a client on the host machine needs URLs signed against the publicly reachable endpoint (e.g., `http://localhost:9000`). The S3 client configuration must distinguish an internal endpoint (worker/API/integration tests) from a public endpoint (presign operations for external clients). Applies equally to TD-06.

### phase-03-videos/TD-03

**Recommendation:** the phase has no requirement demanding different storage policies per asset type; one bucket keeps MinIO provisioning to a single step, and the `videos/{videoId}/...` prefix already gives clean separation between originals and thumbnails without the operational overhead of a second bucket.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** reusing the existing TypeORM entities, config module, and TD-01 queue module avoids duplicating connection/config code that Option B would require rewriting. Invoking `ffmpeg`/`ffprobe` directly sidesteps depending on an archived wrapper library for the phase's core processing logic.
**Libraries:** —

**Note (deployment shape):** the worker runs as a separate `compose.yaml` service with its own container (own image layer with the `ffmpeg` binary installed) — matching the C4 diagram's dedicated "Video Worker (FFmpeg)" container. Same codebase, two containers: `nestjs-api` and `video-worker`.

### phase-03-videos/TD-05

**Recommendation:** the capability only asks for uniqueness and no-conflict, both of which the existing UUID convention already guarantees. Introducing a second identifier column and a new dependency would add a maintenance surface (two IDs per video) with no requirement driving it. As a side benefit, UUIDs are non-guessable — groundwork for Phase 05's unlisted-videos-via-direct-link capability.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** it is the only option consistent with the architecture diagram's direct `frontend → storage` streaming relationship, and it delegates 206/Range handling to MinIO instead of reimplementing it in the API. Bandwidth for potentially many concurrent video streams never touches the NestJS process.
**Libraries:** —

**Note:** the dual-endpoint constraint documented in TD-02 (internal vs. public signing endpoint for SigV4) applies identically here.

### phase-03-videos/TD-07

**Recommendation:** it is literally the state set the project plan names, and the phase has no frontend surface to consume finer-grained intermediate states (Option B's benefit). Failure handling composes with whatever retry/backoff TD-01's chosen queue technology provides natively, rather than adding custom retry-counting logic in the application layer.
**Libraries:** —

**Note (to pin during plan-build):** the exact trigger of the `draft → processing` transition must be specified — it happens at the multipart-complete endpoint (API confirms upload and enqueues the job), not at worker pickup, so a video whose job is still queued already reads `processing`.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys).
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** The strict-BFF model already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. A ~50-LOC session helper is grep-friendly and test-friendly. Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Defense in depth on the cookie content (`httpOnly` blocks JS, encryption blocks accidental inspection). Single cookie to manage simplifies logout. Room to carry minimal user metadata for RSC-rendered authenticated chrome.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight refresh detail is non-trivial and goes in the helper from day one — tested by MSW with a concurrent-refresh assertion.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Decoupled from TD-05 — works with Route Handlers or Server Actions. Aligned with shadcn's canonical form primitive (react-hook-form). Zod-first developer ergonomics match the rest of the FE foundation.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Strict-BFF alignment — every mutation visible under `app/api/**`. Test scaffold already exists for Route-Handlers-as-functions. Single mutation surface sets the precedent for Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** No first-render flicker, no round-trip — the session is delivered in the same response as the page HTML. No new BFF endpoint — the cookie is the source of truth.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** First-paint-correct — the user sees the right outcome on the first paint. Single integration pattern across both flows (confirmation is RSC-only; reset is RSC + Client form).
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** it is the only option that preserves the previous decisions (`class-validator` in phase-02-auth/TD-06) without a re-platform; the CLI plugin with `classValidatorShim: true` leverages the existing `class-validator` decorators to infer schemas, keeping boilerplate low. Nestia has real technical merit but the validation-stack migration cost makes it unviable without an upstream supersede decision on TD-06. Manual authoring is discarded.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** the marginal cost over runtime-only is a single npm script (~15 lines) and the benefit is a correct foundation for future frontend integration (offline codegen) without losing the interactive UI that dev/QA use. Static-only alone hurts local dev experience; runtime-only alone compromises the future codegen pipeline. Combining both is dominant.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** aligns with the defensive posture already established in phase 02 and does not compromise legitimate consumers (the committed `openapi.json` from TD-02 serves as "spec consultable outside the UI"). Reopening as always-exposed is trivial in the future if a public API use case appears.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both deferred per rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, queue) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue publishing) | Integration: real capture service (MinIO, BullMQ+Redis) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Exception Filter | Unit + E2E |

_Anti-patterns to avoid (per the guide): unit-testing controllers, mocking configured libs (JwtService, queue client), skipping integration tests for DB-touching services, skipping module compilation tests, using `repository.delete({})` for cleanup, mirror tests, forgetting `afterAll(() => app.close())`, skipping `main.ts` global config reproduction in E2E._

_Video-worker specific note (not in the generic guide, inferred from phase scope): the worker process (TD-04) and its `child_process.spawn` calls to ffmpeg/ffprobe should be tested at the integration level against real sample video fixtures — mocking ffmpeg's output would not catch a wrong CLI flag or a parsing bug in the ffprobe JSON output._
