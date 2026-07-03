---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos.e2e-spec.ts
---

# Video Status, Streaming, and Download Endpoints — Test Plan

## Application Overview

`GET /videos/:id`, `GET /videos/:id/stream` e `GET /videos/:id/download` expõem o status de processamento do vídeo e as URLs de leitura presignadas de streaming/download (per `phase-03-videos/TD-06`). Streaming e download só respondem quando `status = ready`; caso contrário retornam `409 VIDEO_NOT_READY`. Os três endpoints são restritos ao dono do canal (per `video-access-authorization/TD-01`) — sem `@Public()`, protegidos pelo guard JWT default.

## Test Scenarios

### 1. Consultar status/detalhe do vídeo (GET /videos/:id)

**Setup:** `beforeEach` truncando `videos`/`channels`/`users`; bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo o `ValidationPipe` global de `main.ts`; fixture de vídeo pertencente a um canal de um usuário autenticado.

#### 1.1. status-retorna-campos-do-video-para-o-dono

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Dono do canal envia `GET /videos/:id` para um vídeo seu
    - expect: resposta `200` com `id`, `title`, `status`, `duration_seconds`, `metadata`, `error_reason`, `created_at`

### 2. Streaming e download (GET /videos/:id/stream, GET /videos/:id/download)

**Setup:** fixture de vídeo `ready` com `storage_key_original`/`storage_key_thumbnail` apontando para objetos existentes no MinIO de teste; fixture adicional de vídeo `processing` (ainda não pronto). Mesma bootstrap do grupo 1.

#### 2.1. stream-e-download-com-video-pronto-retornam-url-presignada

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Dono do canal envia `GET /videos/:id/stream` para um vídeo com `status = ready`
    - expect: resposta `200` com `{ url, expires_at }`
  2. Dono do canal envia `GET /videos/:id/download` para o mesmo vídeo
    - expect: resposta `200` com `{ url, expires_at }`

#### 2.2. stream-e-download-com-video-nao-pronto-retornam-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Dono do canal envia `GET /videos/:id/stream` para um vídeo com `status = processing`
    - expect: resposta `409` com `errorCode: "VIDEO_NOT_READY"`
  2. Dono do canal envia `GET /videos/:id/download` para o mesmo vídeo
    - expect: resposta `409` com `errorCode: "VIDEO_NOT_READY"`

#### 2.3. endpoints-de-leitura-restritos-ao-dono

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-03T20:48:16Z

**Steps:**
  1. Um usuário autenticado que não é dono do canal envia `GET /videos/:id`, `GET /videos/:id/stream` e `GET /videos/:id/download`
    - expect: as três respostas são `403` com `errorCode: "VIDEO_NOT_OWNED"`
  2. As mesmas três requisições sem header `Authorization`
    - expect: as três respostas são `401`
