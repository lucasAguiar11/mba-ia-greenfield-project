# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/9 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Queue Module and Video Processing Job Producer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Video Ownership Authorization
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Upload Initiation and Completion Endpoints
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Video Worker: Metadata Extraction and Thumbnail Generation
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Video Worker Docker Service
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Video Status, Streaming, and Download Endpoints
- **Status:** pending
- **Tests:** —
- **Observations:** none
