---
libs:
  bullmq:
    version: "^5.79.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-06T17:35:34-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-06T17:35:34-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-06T17:35:34-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-06T17:35:34-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T16:45:33-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in `technical-decisions-phase-03-videos.md` (TD-01 queue, TD-02/TD-03 storage). Pulled via Context7 (same IDs already cited in the TD's Research Methodology Note). `ffmpeg`/`ffprobe` are CLI binaries invoked via `child_process.spawn` (TD-04) — not an npm library, so no entry here.

## bullmq / @nestjs/bullmq

**Source:** `/taskforcesh/bullmq` (Context7). Maps to `phase-03-videos/TD-01` (Option A, decided).

### Processor pattern used by `VideoProcessor` (`src/worker/video.processor.ts`)

The NestJS integration wraps a plain BullMQ `Worker` behind `WorkerHost` — extend it, decorate the class with `@Processor(queueName)`, and implement `process(job)`:

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessJobPayload>): Promise<void> {
    // ffprobe/ffmpeg + storage calls
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<VideoProcessJobPayload>) {
    // only mark the video `error` once attemptsMade >= attempts (no retries left)
  }
}
```

### Retries and backoff (producer side, `src/queue/video-queue.producer.ts`)

`attempts` + `backoff` are set on the job at enqueue time, not on the worker. BullMQ retries automatically on a thrown error from `process()`; the built-in `exponential` strategy is `delay * 2^(attemptsMade - 1)`:

```typescript
await this.queue.add(
  VIDEO_QUEUE_JOBS.PROCESS,
  { videoId },
  { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
);
```

### Terminal vs. retryable failures

A thrown error inside `process()` is retried per the job's `attempts`/`backoff`. To make a failure terminal on the first try (e.g., a corrupted upload — retrying won't fix it), catch it inside `process()`, update the domain state directly, and `return` normally instead of throwing — this is the pattern `VideoProcessor` uses for ffprobe/ffmpeg failures, reserving BullMQ's own retry machinery for infra-level failures (e.g., storage download errors) that propagate as thrown exceptions.

---

## @aws-sdk/client-s3 / @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7). Maps to `phase-03-videos/TD-02` (presigned multipart upload) and `TD-06`/`video-access-authorization/TD-01` (presigned GET for streaming/download).

### Multipart upload sequence (`StorageService`, `src/storage/storage.service.ts`)

Three commands, matching `VideosService.initiateUpload` / `completeUpload`:

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1. Start the upload, get an UploadId
const { UploadId } = await internalClient.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ContentType }),
);

// 2. One presigned PUT URL per part — signed with the PUBLIC-facing client
//    (the browser is outside the Docker network, so publicClient must point
//    at the host-reachable endpoint, not the internal `minio:9000` one)
const url = await getSignedUrl(
  publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 900 },
);

// 3. After the client PUTs every part and collects each response's ETag,
//    assemble the object server-side
await internalClient.send(
  new CompleteMultipartUploadCommand({
    Bucket,
    Key,
    UploadId,
    MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.part_number, ETag: p.etag })) },
  }),
);
```

`expiresIn` defaults to 900 seconds if omitted; the project pins it explicitly via `PRESIGNED_URL_EXPIRATION_SECONDS = 900` for both upload-part and read URLs.

### Presigned GET for streaming/download

Same `getSignedUrl` helper, with a `GetObjectCommand`. `ResponseContentDisposition: 'attachment'` on the command forces a download instead of inline playback — this is the only difference between the `/stream` and `/download` endpoints in `VideosService`:

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(
  publicClient,
  new GetObjectCommand({
    Bucket,
    Key,
    ...(attachment ? { ResponseContentDisposition: 'attachment' } : {}),
  }),
  { expiresIn: 900 },
);
```

Range requests (`Range` header, `206 Partial Content`) are handled by MinIO/S3 itself when the client GETs the presigned URL directly — the NestJS API never proxies the object bytes, so there's no Range-handling code on the API side.

### MinIO compatibility notes

- `forcePathStyle: true` is required for MinIO (virtual-hosted-style bucket URLs don't resolve against a local MinIO container).
- Two separate `S3Client` instances are needed specifically because of Docker networking (`CLAUDE.md` → "Docker Networking"): the internal client talks to the `minio` Compose service name for server-to-server calls, while the client used only to *sign* URLs must use the host-reachable endpoint, since the resulting URL is handed to a browser/client running outside the Compose network.
