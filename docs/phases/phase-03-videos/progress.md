# phase-03-videos — Progress

**Status:** completed
**SIs:** 9/9 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Object Storage/Queue Docker Compose Infra
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - Redis não pôde ser publicado na porta 6379 do host (já ocupada por um container `acl-redis` de outro projeto) — removido o mapeamento de porta do host; o serviço permanece acessível normalmente pela rede interna do Compose via `redis:6379`, que é tudo que o `nestjs-api`/worker precisam.
  - Porta 3000 do host também estava ocupada por um processo `next-server` de outro projeto do usuário (`rate-layer-web`); usuário liberou manualmente antes de subir a stack.
  - Teste nomeado `app.module.integration-spec.ts` em vez de `app.module.spec.ts` (nome literal do SI) — compilar o `AppModule` completo abre conexões reais com Postgres (`TypeOrmModule.forRootAsync`) e Redis (`BullModule.forRootAsync`), então pela regra do projeto (`nestjs-project/CLAUDE.md` → "Test Type Selection") o sufixo correto é `*.integration-spec.ts`.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 3 passing (video.entity.integration-spec.ts)
- **Observations:**
  - A nova relação inversa `Channel.videos: Video[]` exigiu adicionar `Video` ao array de entidades TypeORM em 10 arquivos de teste pré-existentes (auth, users, channels, migrations) — TypeORM falha ao construir os metadados de uma relação cujo alvo não está registrado no `DataSource` de teste. Todos corrigidos.
  - `migrations.integration-spec.ts` precisou de mais que o ajuste de array: o `DROP TABLE channels CASCADE` desse teste também derrubava `videos` (FK). Resolvido incluindo a migration `CreateVideos` no escopo do teste (3 migrations em vez de 2), e o segundo teste ("revert last migration") passou a reverter `videos` — que agora é de fato a última migration — em vez das tabelas de token.
  - Essa mesma correção expôs uma race condition pré-existente: o `Promise.all` que dropava as tabelas gerenciadas em paralelo causava deadlock ocasional do Postgres agora que há 5 tabelas com FKs cruzadas (antes eram 4, com menos encadeamento). Corrigido serializando os drops em ordem filho→pai (`videos`, `refresh_tokens`, `verification_tokens`, `channels`, `users`). Validado com 5 execuções consecutivas sem falha, depois suíte completa 148/148.

### SI-03.3 — Storage Service
- **Status:** completed
- **Tests:** 5 passing (1 `storage.module.spec.ts` + 4 `storage.service.integration-spec.ts`)
- **Observations:**
  - Bucket não é criado automaticamente pelo MinIO — nenhum SI do plano menciona provisionamento de bucket explicitamente. Resolvido dentro do escopo do próprio `StorageService` via `onModuleInit` (HeadBucket, cria via CreateBucket se não existir) — implementação convergente sem TD nova, per o critério do skill `research` (implementation detail, não decisão estratégica).
  - O endpoint público (`localhost:9000`), para onde apontam as URLs presignadas, não é alcançável de dentro do container `nestjs-api` (mesma armadilha de rede documentada no `CLAUDE.md` raiz — "Inside a container, localhost refers to the container itself"). O teste de integração valida o round-trip real (create/complete multipart, leitura via HeadObject) usando um `S3Client` próprio apontando pro endpoint interno (alcançável), e valida as URLs presignadas apenas estruturalmente (host correto, `response-content-disposition=attachment`) em vez de fazer fetch real contra elas.

### SI-03.4 — Queue Module and Video Processing Job Producer
- **Status:** completed
- **Tests:** 3 passing (1 `queue.module.spec.ts` + 2 `video-queue.producer.integration-spec.ts`)
- **Observations:** none

### SI-03.5 — Video Ownership Authorization
- **Status:** completed
- **Tests:** 23 passing na primeira rodada (videos.service.spec.ts, domain-exception.filter.spec.ts estendido, channels.service.spec.ts, channels.service.integration-spec.ts, channels.module.spec.ts); suíte completa revalidada em 164/164 (30 suítes) após corrigir os 2 sites restantes de `new ChannelsService(dataSource)` em `users.service.integration-spec.ts`
- **Observations:**
  - `VideosService.assertOwnership` delega para um novo `ChannelsService.isOwnedByUser(channelId, userId)` em vez de injetar `Repository<Channel>` diretamente — segue a mesma convenção já usada por `UsersService` (consumir `ChannelsService`, não o repositório bruto), preservando Single Responsibility (per `CLAUDE.md` raiz).
  - `ChannelsService` ganhou um segundo parâmetro no construtor (`Repository<Channel>` injetado) — exigiu atualizar 7 sites de `new ChannelsService(...)` em 3 arquivos de teste pré-existentes (`channels.service.spec.ts` ×5, `channels.service.integration-spec.ts` ×1, `users.service.integration-spec.ts` ×2).
  - O filtro de exceção de domínio (`domain-exception.filter.ts`) é genérico (mapeia qualquer `DomainException` pelo `errorCode`/`httpStatus` que a própria subclasse carrega) — nenhuma mudança de código foi necessária nele; só os testes foram estendidos para provar que as 4 novas exceções mapeiam corretamente.

### SI-03.6 — Upload Initiation and Completion Endpoints
- **Status:** completed
- **Tests:** 9 unit (`videos.service.spec.ts`) + 7 E2E (`test/videos.e2e-spec.ts`, autorado a partir de `nestjs-project/specs/video-upload.plan.md`). Suíte completa revalidada: unit+integração 171/171 (30 suítes), E2E 59/59 (4 suítes)
- **Observations:**
  - Bug real encontrado e corrigido: `POST /videos/:id/complete` retornava 201 (default do NestJS para POST) em vez de 200 (documentado no contrato) — faltava `@HttpCode(HttpStatus.OK)`.
  - Bug de infra real e pré-existente encontrado e corrigido: `npm run test:e2e` no `package.json` não tinha `--runInBand`, apesar do `CLAUDE.md` afirmar que "já vem configurado" — com só 3 specs E2E o problema não se manifestava sempre, mas com o 4º arquivo (`videos.e2e-spec.ts`, que também usa `cleanAllTables()` no `beforeEach`) virou uma race condition reprodutível entre workers concorrentes truncando as mesmas tabelas. Corrigido adicionando `--runInBand` ao script `test:e2e`; validado 3x consecutivas sem flake.
  - `ChannelsService` ganhou `findByUserId(userId)` para resolver o canal do usuário autenticado ao iniciar o upload — mesma convenção de delegar para `ChannelsService` em vez de acessar o repositório de `Channel` diretamente.
  - Round-trip real do multipart testado no E2E via um `S3Client` apontando pro endpoint interno do MinIO (mesma técnica do SI-03.3) para de fato subir uma parte e obter um ETag real antes de chamar `/complete` — sem isso, o `CompleteMultipartUploadCommand` falharia contra o MinIO real por referenciar uma parte inexistente.
  - Título derivado do filename e contagem de partes (a partir de `size_bytes`, 5MB por parte, mínimo 1) testados via unit com mocks; cobertura adicional além do que a linha `Tests` vazia do SI sugeria, seguindo o mandato de "pyramid testing" do `CLAUDE.md` raiz para a lógica de negócio real que acabou residindo no `VideosService` (controllers continuam thin/E2E-only).

### SI-03.7 — Video Worker: Metadata Extraction and Thumbnail Generation
- **Status:** completed
- **Tests:** 7 passing (`video.processor.spec.ts` unit + `video.processor.integration-spec.ts` com ffmpeg/ffprobe reais e MinIO real). Suíte completa revalidada: 178/178 unit+integração (32 suítes), 59/59 E2E (4 suítes)
- **Observations:**
  - `ffmpeg`/`ffprobe` não estavam instalados no container de dev (`Dockerfile.dev`) — só seriam instalados na imagem de produção do worker (`Dockerfile.worker`, SI-03.8). Adicionado `ffmpeg` ao `Dockerfile.dev` para que o teste de integração desta SI (que exige binários reais) rode no mesmo container onde toda a suíte roda; distinto do `Dockerfile.worker`, que é a imagem de deploy do worker.
  - Bug real encontrado e corrigido: o seek de thumbnail (`-ss 00:00:01`) num vídeo de teste de exatamente 1s não gerava nenhum frame (ffmpeg saía com código 0, mas sem escrever o arquivo) — um upload real muito curto cairia no mesmo buraco, escapando do tratamento de erro esperado. Corrigido fazendo `generateThumbnail` verificar explicitamente (via `stat`) que o arquivo de saída existe e tem conteúdo, lançando erro caso contrário; seek reduzido para `00:00:00.5` e o vídeo sintético de teste alongado para 2s de margem.
  - Bug real encontrado via smoke-boot manual do `src/worker/main.ts` (não coberto pelos testes automatizados, que constroem seus próprios módulos de teste): `WorkerModule` registrava só `TypeOrmModule.forFeature([Video])`, mas `Video` referencia `Channel` via relação, e `Channel` referencia `User` — `autoLoadEntities` só descobre entidades citadas em algum `forFeature()`, não via relações transitivas. Sem `Channel`/`User` registrados, a metadata do TypeORM falhava ao montar a relação e o worker nunca conseguia conectar ao banco. Corrigido registrando `TypeOrmModule.forFeature([Video, Channel, User])` no `WorkerModule`.
  - Bug de infra real e pré-existente encontrado e corrigido: `npm run test:e2e` não estava de fato fixado a execução single-worker (`--runInBand` ausente do script), causando uma race condition entre workers concorrentes truncando as mesmas tabelas via `cleanAllTables()`. Corrigido adicionando `--runInBand` ao script `test:e2e` no `package.json`; validado com 3 execuções consecutivas sem flake antes de prosseguir.
  - Falha determinística (ffmpeg/ffprobe contra arquivo corrompido) mapeada direto para `status = error` sem lançar exceção, sem retry (retry não resolveria um arquivo corrompido). Falha transitória (storage/DB indisponível) propaga naturalmente para o BullMQ retomar via `attempts`/`backoff` já configurados na SI-03.4; só quando as tentativas se esgotam (`@OnWorkerEvent('failed')` com `attemptsMade >= attempts`) o vídeo é marcado como `error`.

### SI-03.8 — Video Worker Docker Service
- **Status:** completed
- **Tests:** no tests (infra-only, per o próprio SI). Verificado manualmente: `docker compose up -d` sobe `video-worker` `(healthy)`; `ffmpeg -version`/`ffprobe -version` funcionam dentro do container; logs mostram boot limpo do `WorkerModule` sem erros. Suíte completa revalidada sem regressão: 178/178 unit+integração, 59/59 E2E
- **Observations:**
  - Seguindo o padrão já estabelecido no projeto (nenhum container roda a partir de `dist/` compilado — todos usam `ts-node`/Nest CLI direto do código-fonte via bind mount), `Dockerfile.worker` espelha o estilo do `Dockerfile.dev` em vez de um build multi-stage: mesma imagem base, `ffmpeg` adicionado, sem etapa de `npm install` própria (reaproveita o `node_modules` já populado no host pelo bind mount compartilhado com o `nestjs-api`). Novo script `start:worker` (`ts-node -r tsconfig-paths/register src/worker/main.ts`) roda automaticamente como `CMD` do container, diferente do `nestjs-api` (que fica ocioso via `tail -f /dev/null` até alguém rodar `npm run start:dev` manualmente) — o worker precisa iniciar sozinho no `docker compose up -d`, já que não há um fluxo de "dev interativo" para ele.
  - Healthcheck via `pgrep -f 'ts-node.*worker/main'` (não há endpoint HTTP nem CLI de ping para um consumidor de fila) — usa o pacote `procps` já presente na imagem.
  - Não tentei um smoke-test HTTP de ponta a ponta (registrar usuário → upload → completar → worker processar) porque isso exigiria subir o servidor dev do `nestjs-api` manualmente, o que o `CLAUDE.md` raiz proíbe fazer sem pedido explícito do usuário. O core da lógica do worker já foi validado de ponta a ponta contra ffmpeg/ffprobe e MinIO reais na SI-03.7; esta SI verifica apenas a empacotagem/infra, conforme sua própria declaração de testes.

### SI-03.9 — Video Status, Streaming, and Download Endpoints
- **Status:** completed
- **Tests:** 20 unit (`videos.service.spec.ts`, total acumulado) + 11 E2E (`test/videos.e2e-spec.ts`, total acumulado — 3 novos describe blocks: `GET /videos/:id`, stream, download), autorado a partir de `nestjs-project/specs/video-viewing.plan.md`
- **Observations:**
  - Constante `PRESIGNED_URL_EXPIRATION_SECONDS` exportada do `StorageService` para o `VideosService` computar `expires_at` de forma consistente com o tempo real de expiração assinado, em vez de duplicar o número mágico.
  - `completeUpload` refatorado para reusar um novo helper privado `findVideoOrFail` (compartilhado com os 3 métodos novos), eliminando duplicação de "buscar vídeo ou lançar `VideoNotFoundException`".
  - Testes E2E de streaming/download não dependem do worker real ter processado o vídeo — o status é promovido para `ready` diretamente via `videoRepository.update()` no teste, já que a geração da URL presignada não verifica a existência do objeto no MinIO (é só assinatura). O pipeline de processamento real já foi validado ponta a ponta na SI-03.7.

## Final Verification (Definition of Done)

Rodada após as 9 SIs completas, com o `video-worker` já em execução real no Compose (subido na SI-03.8):

1. **`npm test -- --runInBand`** (unit+integração): 189/189 passing, 32/32 suítes
2. **`npm run test:e2e`**: 63/63 passing, 4/4 suítes
3. **`npx tsc --noEmit`**: exit code 0
4. **`npm run lint`**: exit code 0 — 0 erros, 1 warning pré-existente (`auth.service.integration-spec.ts:472`, `no-unsafe-argument`, já coberto por convenção do projeto)
5. **`npm run build`**: exit code 0

**Bugs reais corrigidos durante a final verification:**
- `src/worker/video.processor.ts`: `let metadata;` sem anotação de tipo inferia `any` implícito, disparando 5 erros de lint (`no-unsafe-assignment`/`no-unsafe-member-access`) nos acessos a `metadata.durationSeconds/width/height/codec/bitrate`. Corrigido com `let metadata: ProbedMetadata;`.
- `video.processor.spec.ts` / `video.processor.integration-spec.ts`: helpers `makeJob()` retornavam `Job` genérico (equivalente a `Job<any,any,string>`), causando warnings de `no-unsafe-argument` ao passar para `process()`/`onFailed()` (que esperam `Job<VideoProcessJobPayload>`). Tipados corretamente.
- Dois mocks `jest.fn(async (video) => video)` sem `await` interno (`require-await`) em `videos.service.spec.ts` e `video.processor.spec.ts` — trocados por `jest.fn((video) => Promise.resolve(video))`.
- `video.processor.spec.ts`: `expect.objectContaining(...)`/`expect.stringContaining(...)` usados como valor de propriedade dentro de outro objeto literal disparavam `no-unsafe-assignment` (retornam `any` no `@types/jest`) — mesmo padrão já resolvido em outros specs do projeto; corrigido com helpers tipados locais `objectContaining<T>()`/`stringContaining()`.
- **Race condition real entre o `video-worker` (subido e rodando desde a SI-03.8) e os testes que inspecionam estado da fila real** (`video-queue.producer.integration-spec.ts` e `test/videos.e2e-spec.ts`): o worker consumia os jobs enfileirados pelos testes antes que as asserções rodassem, causando falhas intermitentes (`job` `undefined`, contagens de fila erradas, `ECONNRESET`). Corrigido com `queue.pause()` (global — afeta qualquer worker na mesma fila/Redis, mesmo em outro container) no `beforeAll` desses dois arquivos, com `queue.resume()` no `afterAll` antes do `obliterate`, sem precisar parar o container `video-worker` manualmente.
