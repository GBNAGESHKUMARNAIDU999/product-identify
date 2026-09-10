# InventoryLens

Internal tool for **visual search over inventory catalogs**: import an inventory
from Excel, Word, or Google Sheets/Drive, then photograph a physical item and
get the matching record — with the item's original image (byte-identical), all
its metadata, and an honest confidence score.

## Core guarantees

1. **Source immutability** — uploaded files / linked sheets are read-only inputs. The app writes only to its own database and storage. Originals are never modified.
2. **No lossy re-encoding** — catalog images are stored and served byte-for-byte (verified via sha256 round-trip).
3. **Never claims certainty** — every identify result carries a confidence score. Below `MATCH_THRESHOLD` (default 70%) the UI shows the top 3 candidates and requires human confirmation. Confirmations/rejections are logged in `identify_queries` as a feedback loop.
4. **Zero baked-in API keys** — user-supplied keys, AES-256-GCM encrypted at rest, validated before saving, never logged, never sent to the client.
5. **Idempotent re-import** — re-uploading the same source updates changed rows; it never duplicates the table or rewrites unchanged images.

## Quick start

```bash
npm install
cp .env.example .env          # then set APP_SECRET (any 32+ char random string)
npx prisma db push            # creates .data/dev.db (SQLite)
npm run dev                   # http://localhost:3000
```

Optional: generate the smoke-test catalog (5 items with embedded images):

```bash
node scripts/make-fixture.js   # writes fixtures/smoke-catalog.xlsx
```

Then: Inventories → Import inventory → drop the xlsx → confirm the mapping →
Identify → drop `fixtures/image3.png` (or the harder `image3-query.jpg`).

Production build: `npm run build && npm start`.

## Chrome extension

`chrome-extension/` is a Manifest V3 add-on that talks to the running app
(no app code involved — it uses the same public `/api/identify` endpoint):

1. Start the app (`npm run dev` or `npm start`).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select the `chrome-extension/` folder.
3. Right-click any product image on any website → **Identify with InventoryLens**.
   The result opens in a new tab: verdict (exact 100% / confidence % / top-3),
   the queried photo, the matched catalog image and its full attribute row.
4. The toolbar popup sets the server URL (default `http://localhost:3000`)
   and shows connection status.

## Environment variables

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file (dev default) or a Postgres URL (see Scaling notes) |
| `APP_SECRET` | Master secret deriving the AES-256-GCM key that encrypts stored API keys. **Required before saving any credential.** |
| `MATCH_THRESHOLD` | Confidence threshold 0–1 (default 0.7). Below it, Identify returns top-3 candidates for manual confirmation. |
| `VISION_RERANK_PROVIDER` | Preferred user-keyed provider for the vision re-rank: `openai` \| `google` \| `gemini` \| `anthropic`. On by default; if no key exists for this provider, any other saved vision credential is used automatically. |

## Architecture map

```
src/lib/
  db.ts            Prisma client singleton
  crypto.ts        AES-256-GCM encrypt/decrypt for keys; sha256 fingerprints
  storage.ts       Object-storage abstraction (local-disk driver; swap for S3)
  embeddings.ts    Zero-key matching engine: 4-crop dHash ensemble (256-d) +
                   rotation-invariant ring color/texture descriptor (32-d, w=5),
                   per-block L2-normalized concat. "phash4crop+ring-v3"
  embed-job.ts     Background embedding backfill; skips unchanged images,
                   purges stale model versions
  vision.ts        Adapter layer: user-keyed OpenAI/Gemini/Claude re-rank pass
  rate-limit.ts    Sliding-window limiter (20 identify/min/IP)
  parsers/
    xlsx.ts        SheetJS rows + OOXML drawing-anchor → row image mapping
    docx.ts        mammoth; heading-anchored blocks, key:value pairs, in-order images
    google.ts      Sheets v4 + Drive v3 (api_key or read-only OAuth token)

src/app/api/
  import/parse     POST file/url → preview payload (columns, samples, images, stash)
  import/commit    POST stashId + mapping → idempotent DB write + backfill kickoff
  inventories      GET list (+embedding status) · [id] GET items/DELETE
  items/[id]/image GET original bytes, immutable cache
  identify         POST image → embed → cosine search → (optional re-rank) → verdict
  identify/[id]/confirm  POST user's confirmation/rejection (feedback loop)
  settings/credentials   GET hints · POST validate+save encrypted · DELETE
  embeddings       GET status · POST manual backfill retry

src/app/(pages)
  inventories/     list + import wizard (preview/mapping screen before commit)
  inventories/[id] item grid, search, attribute drawer
  identify         drop/paste zone, verdict banner, side-by-side compare, top-3 picker
  settings         provider key cards (validate & save), threshold explainer
```

## Adding a new inventory source type

1. Add a parser in `src/lib/parsers/<source>.ts` returning
   `{ columns: string[], rows: Record<string,string>[], images: Record<string, Buffer> }`.
2. Branch on its input in `src/app/api/import/parse/route.ts` (file upload or
   URL form), compute a `fingerprint` (sha256 of canonical content), and stash
   the parsed payload exactly like the existing sources.
3. Add the source type to the Prisma `Inventory.sourceType` comment + the
   import wizard UI card. Commit logic is source-agnostic — no changes needed.

## Scaling notes (beyond internal-tool scale)

- **Postgres + pgvector**: change the datasource provider in
  `prisma/schema.prisma`, move `item_image_embeddings.embedding` to
  `vector(288)`, and replace the in-process cosine in `/api/identify` with a
  pgvector `<=>` query. `EMBEDDING_DIM` in `src/lib/embeddings.ts` documents the dimension.
- **Object storage**: implement `putObject/getObject/objectExists` in
  `src/lib/storage.ts` with the S3 SDK; keys are already path-shaped.
- **Rate limiting**: swap the in-memory Map in `rate-limit.ts` for Redis when
  running multiple instances.
- **Search**: item search is JS-side case-insensitive (SQLite limitation); on
  Postgres use `contains` with `mode: "insensitive"`.

## Accuracy feedback loop

`identify_queries` stores every query with vector scores and the user's
confirmed/rejected item. Confirmed pairs where the vector engine was wrong are
the dataset for future retraining/threshold tuning — the schema is already in
place; mining it is roadmap work.

## Security summary

- API keys: AES-256-GCM (`APP_SECRET`-derived key), auth-tagged, IV per record;
  UI shows hints (`sk-te…cret`) only; error paths redact long tokens.
- Uploads: 100MB catalog cap, 10MB query-image cap, extension/MIME checks,
  images re-validated by sharp on read; storage keys are server-generated
  (path-traversal guarded).
- Google access is read-only by construction (GET-only calls). Four credential
  types on Settings: API key (public files), OAuth app (Client ID + Secret →
  consent flow → auto-refreshing token, read-only scopes), a service-account
  JSON key (JWT-minted access tokens — share the sheet/folder with the service
  account's email), or a raw read-only OAuth access token (legacy).
- Identify is rate-limited before any provider spend.

See `DECISIONS.md` for every default chosen and the full smoke-test results.
