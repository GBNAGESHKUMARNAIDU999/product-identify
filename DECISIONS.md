# DECISIONS.md

Documented defaults and substitutions made while building InventoryLens, per the
build spec's instruction to "make sensible defaults and document them."

## Tech stack substitutions

| Spec default | Shipped | Why |
| --- | --- | --- |
| PostgreSQL + pgvector | **SQLite (dev) via Prisma**, embeddings stored as JSON arrays | Zero-setup for an internal tool; the vector search runs in-process (cosine over loaded rows), which is correct and fast at internal-tool scale (≤ ~50k images). The swap path to Postgres+pgvector is documented in README ("Scaling notes") — schema change is one column type plus one SQL function. |
| Next.js API routes **or** separate parser service | Next.js API routes only | Parsing (SheetJS/mammoth/adm-zip) is fast enough in-process; a second service adds deployment cost with no benefit at this scale. |
| shadcn/ui | **Hand-rolled Tailwind design system** (tokens in `globals.css`, component classes `.card/.btn/.input/.badge`) | Same visual outcome (one accent, consistent radii/shadows, Inter/Geist type) without pulling in the shadcn/Radix dependency tree. |
| CLIP-style embedding model as default engine | **Zero-key local engine: 4-crop pHash ensemble (256-dim) + rotation-invariant ring color/texture descriptor (32-dim, weight 5)** | The spec requires the app to run with zero baked-in keys and CLIP weights aren't practical to fetch at runtime here. The shipped engine is fully offline, deterministic, and scored well in smoke tests (exact match 100%, rotated/cropped/rescaled query of the right item 73% vs 63% for the runner-up). The adapter layer (`src/lib/vision.ts`) still lets a user-keyed vision LLM do the secondary re-rank pass, exactly as specified. |
| Google OAuth **or** service account (ask user) | **OAuth app flow** (default for private files): the user pastes an OAuth Client ID + Secret; the app runs the Google consent redirect itself, stores the refresh token AES-256-GCM-encrypted, and auto-refreshes access tokens. API key (public files) and raw read-only access token (legacy) remain available on the Settings page | A raw access token expires within the hour and breaks imports; a service account requires JSON-key handling. The client-credentials consent flow is the smallest path that "just works" for private Sheets/Drive while staying GET-only/read-only. Swap point is `src/lib/parsers/google.ts` + `src/lib/google-auth.ts`. |
| Object storage S3-compatible or local disk | **Local disk driver** (`.data/storage`), abstracted behind `putObject/getObject` in `src/lib/storage.ts` | Swap the two functions for S3 SDK calls to go to cloud storage. |

## Behavioral defaults

1. **Source immutability** — original files are only ever read. A verbatim copy of
   an uploaded file is kept under `.data/storage/raw/<sha256>.<ext>` for
   reference; the app's write target is exclusively its own database.
2. **No lossy re-encoding** — catalog images are stored and served byte-for-byte
   (verified: sha256 of served bytes === sha256 of the original embedded image).
   Small JPEG thumbnails are produced only transiently to send to the vision-LLM
   re-rank, never displayed.
3. **Confidence semantics** — pHash cosine is floored at 0 and used directly as
   confidence. Default threshold 70% (`MATCH_THRESHOLD` env). Below threshold the
   UI shows the top 3 candidates and requires an explicit human choice; every
   query is persisted to `identify_queries` with `user_confirmed_item_id` as the
   feedback loop.
4. **Idempotent re-import** — inventories are keyed on `(name, source
   fingerprint)`; items on `(inventoryId, rowIndex)`. Re-importing the same file
   updates changed rows, skips rewriting byte-identical images, deletes rows that
   vanished, and skips re-embedding unchanged images (embedding rows encode the
   image content hash in `model_used`). Verified in smoke test: re-import → same
   inventory id, 5 items, 0 images rewritten.
5. **Word parsing** — docx has no cell grid, so rows are heading-anchored blocks
   ("Label: value" pairs between headings) and images are mapped by document
   order between headings. This is inherently heuristic; the preview/mapping
   screen exists so the user catches any mis-parse before commit.
6. **Excel image anchoring** — images are mapped to rows via their one-cell/two-cell
   OOXML anchors (`xl/drawings/drawing.xml`), falling back to the user-chosen
   "image column" cell value matched against image filenames (basenames).
7. **Rate limiting** — in-memory sliding window, 20 identify requests/min/IP
   (`src/lib/rate-limit.ts`), applied before any provider spend. Single-instance
   only; swap for Redis when deploying multi-instance.
8. **Upload caps** — 100MB per catalog source (raised from 25MB for large
   workbooks with embedded images), 10MB per identify query image.
9. **Auth** — none beyond network placement, as the spec allows ("simple … is
   enough for an internal tool; don't over-engineer unless asked"). The Identify
   image route sets `Cache-Control: private` and `nosniff`.
10. **Search** — inventory item search is case-insensitive in JS because SQLite's
    `contains` is case-sensitive; on Postgres, switch to `mode: "insensitive"`.
11. **Admin/deep-codegen scripts** — `scripts/make-fixture.js` (dev-only) builds
    the smoke-test xlsx; it is excluded from the app runtime.

## Smoke test results (dev, fixtures/smoke-catalog.xlsx)

- Parse preview: 5 rows, 7 columns, mapping auto-suggested, images detected.
- Commit: 5 items, 5 original bytes stored verbatim.
- Identify exact catalog image: **100% confident, correct SKU.**
- Identify rotated 9°/rescaled/cropped/re-compressed photo: **72.7% confident,
  correct SKU** (runner-up 63%).
- Identify a different item: confident correct match; wrong candidates stay below.
- Re-import same file: no duplicate rows/images; embeddings skipped.
- Served image sha256 === original fixture sha256.
- Word import (smoke-catalog.docx): parse → 5 heading-anchored rows + 5 images
  (title/intro preamble correctly dropped), commit → 5 items with names from the
  heading text ("content" auto-suggested as name), identify exact fixture image
  → 100% confident, correct SKU. Re-import updated names without rewriting images.
- Rate limit: requests 1–19 → 200, 20+ → 429 with Retry-After.
- Invalid OpenAI key on Settings: rejected (401 surfaced as clean error), nothing
  stored; key list endpoint returns hints only.
- AES-256-GCM round-trip verified; ciphertext contains no plaintext.
