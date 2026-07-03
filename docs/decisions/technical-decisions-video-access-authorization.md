---
scope_type: ad-hoc
related_phases: [3]
status: decided
date: 2026-07-03
scope_description: "Authorization model for video streaming and download endpoints during Phase 03, before Phase 04 introduces public/unlisted visibility"
---

# Technical Decisions — Video Streaming/Download Authorization

_Subprojects in scope:_

- `nestjs-project/` — backend enforces the authorization check on the streaming and download endpoints (TD-06 of `phase-03-videos`). All decision content applies here.
- `next-frontend/` — no open decision in this document; the video playback UI is explicitly out of scope for Phase 03 (backend-only challenge phase).

---

## TD-01: Authorization Model for Video Streaming & Download

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `phase-03-videos/TD-06` decided that streaming and download are served via short-lived presigned GET URLs issued by the API, with the client fetching bytes directly from MinIO/S3. That TD settled the *delivery mechanism* but not *who is allowed to request a presigned URL in the first place* — and because a presigned URL grants access to anyone holding the string for its validity window, that request-time check is the only enforcement point that exists; there is no per-byte re-check once the URL is issued.

Phase 03 has no visibility concept yet — "público" vs. "unlisted" is explicitly a Phase 04 capability ("Visibilidade do vídeo: público ou unlisted"), and the draft → publish flow is also Phase 04's ("Fluxo de rascunho → publicação"). During Phase 03, every video that finishes processing sits in a `ready` state (`phase-03-videos/TD-07`) with no publish gate at all. The project's stated top-level vision allows anonymous viewing ("Usuários anônimos podem assistir livremente"), but that vision is realized end-to-end only once Phase 04 (visibility) and Phase 05 (player page) ship — Phase 03 has no consumer-facing surface (frontend video UI is out of scope this phase). The existing backend convention (`nestjs-controllers.md`) protects every endpoint by default via a global JWT guard; public routes opt out explicitly with `@Public()`.

**Options:**

### Option A: Fully public (no auth check)
- The streaming and download endpoints are annotated `@Public()`. Any request — authenticated or not — that supplies a valid video ID receives a presigned URL, regardless of who owns the video or what state it's in.
- **Pros:** Directly matches the anonymous-viewing product vision with zero extra code. Simplest implementation — one decorator, no ownership check.
- **Cons:** Every uploaded video becomes fetchable by anyone who obtains (or guesses/enumerates) its UUID, the moment processing finishes — before the platform has any publish gate or visibility flag. This is a meaningful exposure window: a video a user is still testing/reviewing before "publishing" (a Phase 04 concept that doesn't exist yet) would already be world-readable in Phase 03. Retrofitting a restriction later means adding a check where none existed, a higher-risk change than tightening one that already exists.

### Option B: Owner-only (default-protected, ownership check)
- No `@Public()` — the endpoints stay behind the global JWT guard by default (the existing convention's "do nothing extra" path). The handler additionally verifies the authenticated user's channel owns the requested video before issuing a presigned URL; otherwise it throws a domain exception mapped to `403`.
- **Pros:** Consistent with the project's established default-protected-by-default posture (no new opt-out to reason about). No video is exposed beyond its owner until a later phase deliberately opens it up. The ownership check this TD introduces is exactly the hook Phase 04's visibility feature will extend (add an `OR video.visibility = 'public'` branch) rather than retrofit from scratch.
- **Cons:** The anonymous-viewing vision is not observable end-to-end in Phase 03 — but Phase 03 has no player UI to observe it with anyway (out of scope), so this is not a regression against anything Phase 03 itself delivers.

### Option C: Authenticated, any user (default-protected, no ownership check)
- No `@Public()`, but no ownership check either — any authenticated user (not just the video's owner) can request a presigned URL for any video.
- **Pros:** Slightly closer to "shareable" than Option B without being fully public.
- **Cons:** Solves neither problem well: still exposes every user's videos to every other registered user with no publish gate (weaker than B, same exposure-before-publish issue as A but requires an account), and still doesn't deliver real anonymous viewing (weaker than A). A middle ground that inherits the downsides of both without a clear scenario it uniquely serves.

**Recommendation:** **Option B (Owner-only)** — it is the only option that doesn't expose unpublished video content to a wider audience than the platform has a mechanism to intentionally grant yet. It costs one ownership check (channel-of-video == channel-of-authenticated-user), reuses the JWT guard already global to the app, and is structured so Phase 04's visibility feature extends it (add a public/unlisted bypass branch) instead of retrofitting access control onto a route that started fully open.

**Decision:** B (Owner-only)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Authorization Model for Video Streaming & Download | B (Owner-only) | B (Owner-only) |
