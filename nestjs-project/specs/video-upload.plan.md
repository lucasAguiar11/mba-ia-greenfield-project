---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos.e2e-spec.ts
---

# Upload Initiation and Completion Endpoints — Test Plan

## Application Overview

`POST /videos` e `POST /videos/:id/complete` implementam o fluxo de upload multipart presignado (per `phase-03-videos/TD-02`): o primeiro pré-cadastra o vídeo como `draft` (título auto-derivado do nome do arquivo, per `phase-03-videos/TD-07` note) e retorna as URLs de parte presignadas calculadas a partir do tamanho do arquivo; o segundo finaliza o multipart no storage, move o vídeo para `processing` e enfileira o job `video.process` na fila `video-processing` (per `phase-03-videos/TD-01`). Ambos os endpoints são restritos ao dono do canal (per `video-access-authorization/TD-01`) — sem `@Public()`, protegidos pelo guard JWT default.

## Test Scenarios

### 1. Iniciar upload multipart (POST /videos)

**Setup:** `beforeEach` truncando `videos`/`channels`/`users`; bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo o `ValidationPipe` global de `main.ts`; usuário autenticado dono de um canal existente.

#### 1.1. upload-iniciado-cria-rascunho-e-retorna-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Usuário autenticado (dono de canal) envia `POST /videos` com `{ filename, content_type, size_bytes }` válidos
    - expect: resposta `201`
    - expect: corpo contém `id`, `upload_id` e `part_urls` — uma entrada `{ part_number, url }` por parte calculada a partir de `size_bytes`
    - expect: o vídeo criado no banco está em `status = draft`, com `title` derivado do `filename` (sanitizado, extensão removida)

#### 1.2. upload-iniciado-payload-invalido

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Usuário autenticado envia `POST /videos` sem `filename` (ou com `size_bytes` não numérico)
    - expect: resposta `400`

### 2. Concluir upload multipart (POST /videos/:id/complete)

**Setup:** reaproveita o vídeo `draft` criado pelo cenário 1.1 (ou fixture equivalente); mesma bootstrap do grupo 1.

#### 2.1. upload-concluido-move-para-processing-e-enfileira-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Dono do vídeo envia `POST /videos/:id/complete` com `{ parts: [...] }` válido
    - expect: resposta `200` com `{ id, status: "processing" }`
    - expect: o vídeo no banco está em `status = processing`
    - expect: um job `video.process` foi enfileirado na fila `video-processing` com payload `{ videoId }`

#### 2.2. upload-conclusao-por-nao-dono-retorna-403

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Um usuário autenticado que não é dono do canal do vídeo envia `POST /videos/:id/complete`
    - expect: resposta `403` com `errorCode: "VIDEO_NOT_OWNED"`

#### 2.3. upload-conclusao-duplicada-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Dono do vídeo conclui o upload com sucesso (`200`)
    - expect: resposta `200`
  2. O mesmo dono envia `POST /videos/:id/complete` novamente para o mesmo vídeo
    - expect: resposta `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 2.4. upload-sem-autenticacao-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Requisição `POST /videos` sem header `Authorization`
    - expect: resposta `401`
  2. Requisição `POST /videos/:id/complete` sem header `Authorization`
    - expect: resposta `401`
