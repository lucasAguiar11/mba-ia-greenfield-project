---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-03T17:28:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T16:45:33-03:00"
  docs/decisions/technical-decisions-video-access-authorization.md: "2026-07-03T17:12:06-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-29T11:39:20-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar o módulo de vídeos do backend (`nestjs-project/`): upload de vídeos de até 10GB sem impacto na performance da API via multipart presignado direto ao object storage, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano (extração de duração/metadados via ffmpeg/ffprobe e geração de thumbnail) através de uma fila dedicada, URL única por vídeo sem conflito, e reprodução via streaming e download por URLs de leitura presignadas restritas ao dono do canal — entregando upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Object Storage/Queue Docker Compose Infra

**Description:** Instala as dependências de storage e fila, cria os namespaces de config seguindo a convenção herdada (`registerAs`), e sobe MinIO e Redis como serviços novos no `compose.yaml`.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@nestjs/bullmq`, `bullmq`, `ioredis`.
2. Adicionar os serviços `minio` e `redis` ao `compose.yaml` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
3. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` como factories `registerAs` — um arquivo por domínio, seguindo o padrão herdado.
4. Adicionar as novas env vars (endpoint interno/público do MinIO, nome do bucket, host/porta do Redis) ao `.env.example` e estender o schema Joi em `src/config/env.validation.ts`.
5. Registrar os namespaces de config e `BullModule.forRootAsync` em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AppModule` (wiring de storage/queue) | Unit: compilation test | `app.module.spec.ts` (estendido) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe os containers `minio` e `redis` saudáveis junto com os serviços já existentes.
- `AppModule` compila com `BullModule` e os novos namespaces de config registrados (teste de compilação passa).
- `.env.example` documenta toda variável nova obrigatória; `npx tsc --noEmit` passa.

---

### SI-03.2 — Video Entity and Migration

**Description:** Cria a entidade `Video` ligada ao canal e a migration correspondente, seguindo a convenção herdada de UUID como PK e `TypeOrmModule.forFeature`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme o Data Model (campos, `@ManyToOne` para `Channel`).
2. Gerar a migration `CreateVideos` via `npm run migration:generate` e revisar o SQL gerado.
3. Rodar a migration contra o banco de desenvolvimento.
4. Criar o esqueleto de `VideosModule` registrando `TypeOrmModule.forFeature([Video])`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, FK para `Channel` | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A migration cria a tabela `videos` com todas as colunas do Data Model e a FK para `channels`.
- A coluna `status` da entidade `Video` assume `draft` por padrão quando não especificada.
- Inserir um `Video` com `channel_id` inválido viola a constraint de FK.

---

### SI-03.3 — Storage Service

**Description:** Encapsula o cliente S3 com endpoint dual (interno para operações da API, público para URLs presignadas devolvidas ao cliente) e os métodos de multipart upload e leitura presignada.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client` (interno e público) construídos a partir de `storage.config.ts` (per `phase-03-videos/TD-02`).
2. Implementar `createMultipartUpload`, `getUploadPartUrl` (presigned `UploadPart`) e `completeMultipartUpload`.
3. Implementar `getPresignedGetUrl(key, { attachment })` usando o cliente público, aplicando `ResponseContentDisposition` quando `attachment` (per `phase-03-videos/TD-06`).
4. Registrar `StorageModule` como módulo exportável, sem dependência de `VideosModule` (evitar acoplamento invertido).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: contra MinIO real do compose | `storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `storage.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` válido reconhecido pelo MinIO.
- `getPresignedGetUrl` com `attachment: true` produz uma URL cujo `ResponseContentDisposition` é `attachment`.
- As URLs presignadas usam o endpoint público configurado, não o endpoint interno usado pela API para chamadas server-to-server.

---

### SI-03.4 — Queue Module and Video Processing Job Producer

**Description:** Registra a fila `video-processing` no BullMQ e expõe o método de enfileiramento usado pelo fluxo de upload.

**Technical actions:**

1. Registrar `BullModule.registerQueue({ name: 'video-processing' })` em `QueueModule` (per `phase-03-videos/TD-01`).
2. Definir o payload do job `video.process` (`{ videoId: string }`) e sua tipagem.
3. Implementar `VideoQueueProducer.enqueueVideoProcessing(videoId)` com `attempts` + `backoff` exponencial configurados (per `phase-03-videos/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `queue.module.spec.ts` |
| `VideoQueueProducer` | Integration: contra Redis real do compose | `video-queue.producer.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `enqueueVideoProcessing(videoId)` insere um job na fila `video-processing` com o payload `{ videoId }`.
- O job criado tem política de retry com backoff exponencial configurada (não `attempts: 1`).

---

### SI-03.5 — Video Ownership Authorization

**Description:** Implementa as exceções de domínio do módulo de vídeos e a verificação de posse (dono do canal) reutilizada por todos os endpoints subsequentes.

**Technical actions:**

1. Criar `VideoNotFoundException`, `VideoNotOwnedException`, `VideoNotReadyException`, `UploadAlreadyCompletedException` em `src/videos/exceptions/`, seguindo a convenção herdada de exceções de domínio.
2. Implementar `VideosService.assertOwnership(video, userId)` — carrega o canal do vídeo e verifica se pertence ao usuário autenticado, lançando `VideoNotOwnedException` caso contrário (per `video-access-authorization/TD-01`).
3. Mapear as quatro exceções nos filtros de exceção de domínio já existentes (`domain-exception.filter.ts`) para os códigos HTTP do Error Catalog.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.assertOwnership` | Unit: branch logic (mock repo) | `videos.service.spec.ts` |
| `domain-exception.filter` (novos mapeamentos) | Unit | `domain-exception.filter.spec.ts` (estendido) |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `assertOwnership` não lança quando o vídeo pertence ao canal do usuário autenticado.
- `assertOwnership` lança `VideoNotOwnedException` quando o vídeo pertence a outro canal.
- `VideoNotFoundException`, `VideoNotOwnedException`, `VideoNotReadyException` e `UploadAlreadyCompletedException` são mapeadas para 404, 403, 409 e 409 respectivamente pelo filtro.

---

### SI-03.6 — Upload Initiation and Completion Endpoints

**Route:** POST /videos

**Route:** POST /videos/:id/complete

**Test Specs:** see `nestjs-project/specs/video-upload.plan.md`

**Authorization:** Owner only (per `video-access-authorization/TD-01`)

**Description:** Implementa os dois endpoints do fluxo de upload multipart: início (pré-cadastro do rascunho + URLs de parte) e conclusão (finaliza o multipart e dispara o processamento).

**Technical actions:**

1. Criar `CreateVideoUploadDto` (filename, content_type, size_bytes) e `CompleteVideoUploadDto` (parts array) com `class-validator`.
2. Implementar `POST /videos`: deriva o título a partir do filename (sanitizado, sem extensão — per `phase-03-videos/TD-07` note), cria o `Video` em `draft`, chama `StorageService.createMultipartUpload`, calcula as part URLs e retorna `{ id, upload_id, part_urls }`.
3. Implementar `POST /videos/:id/complete`: valida posse (`assertOwnership`), rejeita com `UploadAlreadyCompletedException` se já concluído, chama `StorageService.completeMultipartUpload`, atualiza `status` para `processing` e chama `VideoQueueProducer.enqueueVideoProcessing` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`).
4. Aplicar o guard JWT default-protegido (sem `@Public()`) em `VideosController` (per `video-access-authorization/TD-01`).
5. Adicionar decorators Swagger (`@ApiOperation`, `@ApiResponse`) nos dois endpoints, seguindo a convenção herdada de `openapi-docs-nestjs`.

**Tests:** _(empty — controller wiring; branch logic covered by SI-03.3/SI-03.4/SI-03.5's own tests, E2E owned by /plan-test-specs spec)_

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` autenticado cria um `Video` em `draft` e retorna `part_urls` com uma entrada por parte calculada a partir de `size_bytes`.
- `POST /videos` com corpo inválido retorna 400.
- `POST /videos/:id/complete` autenticado como dono move o vídeo para `processing` e enfileira o job `video.process`.
- `POST /videos/:id/complete` chamado por um usuário que não é dono do canal retorna 403.
- `POST /videos/:id/complete` chamado uma segunda vez para o mesmo vídeo retorna 409 `UPLOAD_ALREADY_COMPLETED`.
- Requisição sem token de autenticação retorna 401 em ambos os endpoints.

---

### SI-03.7 — Video Worker: Metadata Extraction and Thumbnail Generation

**Description:** Aplicação NestJS standalone que consome a fila `video-processing`, extrai metadados via ffprobe, gera thumbnail via ffmpeg, faz upload do resultado e atualiza o status do vídeo (per `phase-03-videos/TD-04`).

**Technical actions:**

1. Criar o entrypoint standalone `src/worker/main.ts` (`NestFactory.createApplicationContext`), reaproveitando os módulos de config, storage, queue e vídeos.
2. Implementar `VideoProcessor` (`@Processor('video-processing')`) que consome o job `video.process`.
3. Implementar a extração de metadados via `child_process.spawn('ffprobe', ...)` (duração, largura, altura, codec, bitrate).
4. Implementar a geração de thumbnail via `child_process.spawn('ffmpeg', ...)`, upload do resultado ao storage (`storage_key_thumbnail`).
5. Ao final (sucesso ou falha), atualizar `Video.status` para `ready` (com `duration_seconds`/`metadata`/`storage_key_thumbnail` preenchidos) ou `error` (com `error_reason`) (per `phase-03-videos/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` (parsing/branching) | Unit: mock spawn + mock repo | `video.processor.spec.ts` |
| `VideoProcessor` (fluxo completo) | Integration: ffmpeg/ffprobe reais contra um vídeo de teste + MinIO real | `video.processor.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- Processar um vídeo válido resulta em `status = ready`, `duration_seconds` preenchido e `storage_key_thumbnail` apontando para um objeto existente no bucket.
- Uma falha do ffmpeg/ffprobe (arquivo corrompido) resulta em `status = error` com `error_reason` preenchido, sem lançar exceção não tratada no worker.
- O job é retomado (retry) conforme a política de backoff de `phase-03-videos/TD-01` quando falha por erro transitório.

---

### SI-03.8 — Video Worker Docker Service

**Description:** Empacota o worker como serviço Docker próprio, com ffmpeg instalado na imagem, consumindo a mesma configuração de fila/storage da API.

**Technical actions:**

1. Criar `Dockerfile.worker` — imagem Node com `ffmpeg` instalado, `CMD` apontando para `dist/worker/main.js` (per `phase-03-videos/TD-04`).
2. Adicionar o serviço `video-worker` ao `compose.yaml`, com as mesmas env vars de storage/fila/banco da API.

**Tests:** _None — infra-only change, verified by Deliverables' full stack boot._

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `docker compose up -d` sobe o container `video-worker` saudável, consumindo jobs da fila `video-processing`.
- `ffmpeg -version` e `ffprobe -version` executam com sucesso dentro do container `video-worker`.

---

### SI-03.9 — Video Status, Streaming, and Download Endpoints

**Route:** GET /videos/:id

**Route:** GET /videos/:id/stream

**Route:** GET /videos/:id/download

**Test Specs:** see `nestjs-project/specs/video-viewing.plan.md`

**Authorization:** Owner only (per `video-access-authorization/TD-01`)

**Description:** Implementa os três endpoints de leitura do vídeo: status/detalhe, streaming e download, todos restritos ao dono do canal.

**Technical actions:**

1. Implementar `GET /videos/:id`: valida posse (`assertOwnership`) e retorna os campos do Data Model expostos no contrato (id, title, status, duration_seconds, metadata, error_reason, created_at).
2. Implementar `GET /videos/:id/stream`: valida posse, rejeita com `VideoNotReadyException` se `status != ready`, retorna `{ url, expires_at }` via `StorageService.getPresignedGetUrl` com disposição inline (per `phase-03-videos/TD-06`).
3. Implementar `GET /videos/:id/download`: mesma validação, retorna `{ url, expires_at }` com `attachment: true`.
4. Adicionar decorators Swagger nos três endpoints, seguindo a convenção herdada de `openapi-docs-nestjs`.

**Tests:** _(empty — controller wiring; branch logic covered by SI-03.3/SI-03.5's own tests, E2E owned by /plan-test-specs spec)_

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `GET /videos/:id` autenticado como dono retorna os campos do vídeo, incluindo `status`.
- `GET /videos/:id/stream` e `GET /videos/:id/download` com `status = ready` retornam uma URL presignada válida e `expires_at`.
- `GET /videos/:id/stream` e `GET /videos/:id/download` com `status != ready` retornam 409 `VIDEO_NOT_READY`.
- Qualquer um dos três endpoints chamado por um usuário que não é dono do canal retorna 403; chamado sem autenticação retorna 401.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null — auto-derived from the uploaded file's original filename at draft creation, sanitized, extension stripped (per `phase-03-videos/TD-07` note) |
| status | enum(`draft`, `processing`, `ready`, `error`) | not null, default `draft` (per `phase-03-videos/TD-07`) |
| error_reason | text | nullable — last failure reason when `status = error` (per `phase-03-videos/TD-07`) |
| storage_key_original | varchar(512) | not null — `videos/{id}/original.<ext>` (per `phase-03-videos/TD-03`) |
| storage_key_thumbnail | varchar(512) | nullable until processed — `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-03`) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId` (per `phase-03-videos/TD-02`) |
| duration_seconds | integer | nullable until processed (per `phase-03-videos/TD-04`) |
| metadata | jsonb | nullable until processed — width, height, codec, bitrate extracted by the worker (per `phase-03-videos/TD-04`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Video` belongs to `Channel` (many-to-one); `Channel` has many `Video` (one-to-many).
**Indexes:** FK index on `channel_id`.

---

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- filename: string, required
- content_type: string, required — MIME type of the uploaded video
- size_bytes: integer, required — total file size; the server computes the multipart part count and part URLs from this value

**Response 201:**
- id: string (uuid)
- upload_id: string
- part_urls: array of `{ part_number: integer, url: string }` — one presigned `UploadPart` URL per part (per `phase-03-videos/TD-02`)

**Error responses:**
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/complete (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- parts: array of `{ part_number: integer, etag: string }`, required — one entry per uploaded part, as returned by the client's `PUT` to each part URL

**Response 200:**
- id: string (uuid)
- status: string (`processing`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 403 VIDEO_NOT_OWNED: when the authenticated user's channel does not own the video
- 409 UPLOAD_ALREADY_COMPLETED: when the multipart upload was already completed for this video
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/:id (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- title: string
- status: string (`draft` | `processing` | `ready` | `error`)
- duration_seconds: integer | null
- metadata: object | null
- error_reason: string | null
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 403 VIDEO_NOT_OWNED: when the authenticated user's channel does not own the video

---

#### GET /videos/:id/stream (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET URL against the object storage's publicly reachable endpoint, inline disposition (per `phase-03-videos/TD-06`, dual-endpoint constraint per `phase-03-videos/TD-02`)
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 403 VIDEO_NOT_OWNED: when the authenticated user's channel does not own the video (per `video-access-authorization/TD-01`)
- 409 VIDEO_NOT_READY: when the video's `status` is not `ready`

---

#### GET /videos/:id/download (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET URL against the object storage's publicly reachable endpoint, `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-06`)
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 403 VIDEO_NOT_OWNED: when the authenticated user's channel does not own the video (per `video-access-authorization/TD-01`)
- 409 VIDEO_NOT_READY: when the video's `status` is not `ready`

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| GET /videos/:id | ✗ | ✗ | ✓ |
| GET /videos/:id/stream | ✗ | ✗ | ✓ |
| GET /videos/:id/download | ✗ | ✗ | ✓ |

All five endpoints are owner-only per `video-access-authorization/TD-01` — a merely-authenticated user who is not the video's channel owner is rejected with `403 VIDEO_NOT_OWNED`, same as an anonymous caller is rejected with `401` by the global JWT guard (default-protected convention, no `@Public()`).

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo com o id informado não existe |
| VIDEO_NOT_OWNED | 403 | Usuário autenticado não é o dono do canal do vídeo (per `video-access-authorization/TD-01`) |
| VIDEO_NOT_READY | 409 | Streaming ou download solicitado antes de `status = ready` |
| UPLOAD_ALREADY_COMPLETED | 409 | `POST /videos/:id/complete` chamado para um upload cujo multipart já foi finalizado |

`VALIDATION_ERROR` is inherited from `phase-02-auth/TD-07`'s error envelope — no new definition needed here.

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-04`)
**Trigger:** multipart upload completion confirmed (`POST /videos/:id/complete`)
**Delivery semantics:** at-least-once, retried with exponential backoff per BullMQ `attempts` + `backoff` config (per `phase-03-videos/TD-01`)

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.3
└── SI-03.4

SI-03.2 (no deps)
└── SI-03.5

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6

SI-03.4 + SI-03.5
└── SI-03.7
    └── SI-03.8

SI-03.3 + SI-03.5
└── SI-03.9
```

Linearized implementation order: SI-03.1, SI-03.2 (parallel) → SI-03.3, SI-03.4, SI-03.5 (parallel) → SI-03.6, SI-03.7, SI-03.9 (parallel) → SI-03.8

---

## Deliverables

- [ ] Upload multipart iniciado via `POST /videos` cria o vídeo em `draft` e retorna URLs de parte presignadas calculadas a partir do tamanho do arquivo
- [ ] Título do vídeo auto-derivado do nome do arquivo enviado (sanitizado, sem extensão)
- [ ] Conclusão do upload via `POST /videos/:id/complete` finaliza o multipart, move o vídeo para `processing` e enfileira o job de processamento
- [ ] Fila dedicada `video-processing` (BullMQ + Redis) com retry e backoff exponencial
- [ ] Worker de vídeo extrai duração/metadados via ffprobe e gera thumbnail via ffmpeg, atualizando o vídeo para `ready` ou `error`
- [ ] Worker roda em container Docker próprio (`video-worker`) com ffmpeg instalado
- [ ] `GET /videos/:id` expõe o status de processamento do vídeo (`draft`, `processing`, `ready`, `error`)
- [ ] Streaming (`GET /videos/:id/stream`) e download (`GET /videos/:id/download`) retornam URLs de leitura presignadas de curta duração
- [ ] Todos os endpoints de vídeo restritos ao dono do canal (401 anônimo, 403 `VIDEO_NOT_OWNED` para não-donos)
- [ ] Bucket único com chaves prefixadas por tipo (`videos/{id}/original.<ext>`, `videos/{id}/thumbnail.jpg`) garante URL única por vídeo sem conflito
- [ ] MinIO e Redis provisionados via Docker Compose

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
