# SourcePad

A document-grounded AI workspace for organizing sources, asking questions, and inspecting the passages behind an answer. SourcePad combines private notebooks with a separate general-purpose chat.

[Repository](https://github.com/arielBiagio/SourcePad)

The interface and document-answering prompts are currently in Spanish.

## Features

- **Notebooks:** create, search, rename, and delete topic-based workspaces. A notebook must be empty of sources before it can be deleted.
- **Document sources:** upload PDF, TXT, and Markdown files; extract their text; inspect chunks; preview originals; download or remove sources.
- **Document-grounded answers:** search indexed sources in the active notebook and receive streamed answer blocks with numbered references.
- **Inspectable citations:** open a compact source preview, expand the full chunk, or view an original document full-screen. PDF previews include page and zoom controls.
- **Two chat histories:** notebook conversations persist in PostgreSQL; general chat and its draft remain in the current browser tab through `sessionStorage`, scoped to the signed-in user.
- **Account access:** email/password registration, sign-in, email confirmation, and sign-out through Supabase Auth.
- **Responsive workspace:** a dark Terracota theme, distinct notebook and source panels, a central chat, mobile panel tabs, and reduced-motion support. Enter sends a message; Shift + Enter adds a line.

## Technology stack

- **Frontend:** HTML, CSS, native JavaScript modules, Tailwind CSS, Marked, and DOMPurify.
- **Backend:** Node.js, Express, Multer, and worker threads.
- **Data and identity:** Supabase Auth, PostgreSQL with pgvector, and private Supabase Storage.
- **Document processing:** PDF.js for PDF extraction and browser previews; UTF-8 decoding for TXT and Markdown.
- **AI:** OpenRouter through the OpenAI-compatible JavaScript SDK.
- **Development tooling:** PostCSS, Node Test Runner, Playwright, and PGlite.

Better Auth and SQLite remain available as a legacy authentication mode for general chat. Document notebooks require Supabase.

## Architecture

Express serves both the frontend and the HTTP API from one origin. Browser modules manage the interface, requests, streaming, and local chat state; the server handles authentication, file processing, retrieval, and model calls.

```text
Browser UI
   |
   v
Express: static assets + authenticated API
   |-- Supabase Auth: identity and session validation
   |-- PostgreSQL / pgvector: notebooks, chunks, vectors, conversations
   |-- Private Storage: original source files
   |-- Worker thread: server-side text extraction and chunking
   `-- OpenRouter: embeddings and streamed generation
```

Database requests use the signed-in user's Supabase session. Owner filters, row-level security policies, and Storage policies scope access to that user's resources. OpenRouter credentials stay on the server; session tokens are not exposed to frontend JavaScript.

### How document answers work

1. **Upload:** validate the file and store its original in a private bucket, with metadata in PostgreSQL.
2. **Process:** extract and normalize text on the server. Split it into chunks of up to 1,200 Unicode code points with 180-character overlap, without crossing PDF page boundaries.
3. **Index:** generate normalized, 1,024-dimensional BGE-M3 embeddings in batches of up to 32 chunks. Save completed batches so indexing can pause between batches and resume.
4. **Retrieve:** embed the question and rank eligible chunks by cosine distance within the active notebook. The interface searches all its fully indexed sources.
5. **Generate:** send the question and up to five retrieved chunks to the generation model. Validate complete answer blocks and their source identifiers before streaming them to the browser. Save the conversation after the complete answer passes validation.

An interrupted generation is not saved as a completed notebook answer. A completed answer can still be shown if saving its history fails.

### Context management

Document retrieval happens **before** generation: the generator does not receive the whole PDF, every source, or earlier notebook exchanges. Each notebook question is independent, even though its history remains visible. The interface loads the latest 30 exchanges.

The retrieved chunks are passed as text with filenames and page metadata. There is no separate summarization or reranking step; the model produces its answer from that bounded selection.

General chat uses a different strategy: send at most six recent messages, dropping older context when needed to fit the browser's request-size budget. Keeping more messages on screen does not send the full conversation back to the model.

## AI integration

OpenRouter provides two separate roles. The generation model is configurable through `OPENROUTER_CHAT_MODEL`, which defaults in code to `qwen/qwen3.8-flash`. Embeddings use the fixed `baai/bge-m3` profile.

There is **no MCP server or model-callable tool interface** in this application. The following capabilities are orchestrated by the backend, not exposed as agent tools.

| Capability | What it does | Implementation |
| --- | --- | --- |
| Document indexing | Converts extracted chunks into reusable vectors | OpenRouter embeddings, BGE-M3, 1,024 dimensions |
| Semantic retrieval | Selects relevant chunks owned by the user in the active notebook | Question embedding and pgvector cosine search |
| Grounded generation | Produces structured answer blocks with source identifiers | OpenRouter chat completion with a required JSON schema |
| General chat | Answers independently of uploaded sources | OpenRouter chat completion with recent conversation context |

The document generator must support structured outputs and streaming. Changing it does not require reindexing; changing the embedding model or profile requires corresponding code/schema changes and rebuilding the vectors.

Citations resolve to retrieved chunks. Their preview is copied from the first 300 characters of the source chunk, not generated as an exact supporting quotation. This makes provenance inspectable; it does **not** establish that every claim correctly interprets the source.

### Access, data flow, and limits

- Chat and notebook operations require a session. Supabase sessions use `HttpOnly`, `SameSite=Lax` cookies; `Secure` is enabled when `APP_URL` uses HTTPS. There are no application-level admin roles or shared notebooks.
- Extraction runs on the application server. Indexing sends extracted text to OpenRouter and its embedding provider; document questions send the query and retrieved chunks to the generator. General chat sends its selected recent messages.
- The document flow requests provider routing with `data_collection: deny`. This is not a guarantee about every provider's retention practices, and the general-chat request does not set that option.
- Files are limited to 10 MiB each. Extraction also limits PDF length to 200 pages, text to one million characters, and output to 1,500 chunks. Document questions accept up to 1,000 characters.
- Request rate limits, processing timeouts, and per-process concurrency limits are implemented. Model calls have no automatic retries or fallback model; the generation request caps output at 2,048 tokens.
- There is no application-wide spending cap. Indexing and generation can consume provider credit, including failed or cancelled attempts.

Removing a source does not remove excerpts already stored in notebook conversation history. Clear that conversation as well if those excerpts should be removed.

## Design decisions

- **A same-origin application:** serving pages and API together keeps cookie handling and deployment in one Node.js service, without a separate frontend API origin.
- **Explicit processing stages:** upload, extraction, and indexing are separate operations. Users can inspect extracted text before paying for embeddings and resume from saved indexing batches.
- **Page-aware chunks:** overlap retains nearby context, while page metadata and normalized-text offsets support source inspection.
- **A versioned embedding profile:** matching dimensions, normalization, and content hashes keeps retrieval tied to the text that was indexed. Vectors and application data live in the same PostgreSQL database.
- **Validated block streaming:** notebook answers appear progressively without publishing unfinished JSON. Source IDs are checked separately from the model's wording.
- **Different persistence for different conversations:** notebook exchanges belong with their sources in the database; general chat stays tab-local rather than introducing another server-side history store.
- **Bounded extraction workers:** parsing runs outside the main event loop with time and V8 memory limits. Worker threads are not an operating-system security sandbox.

## Run locally

Use Node.js 24, npm, a Supabase project, and an OpenRouter API key with access to the configured models.

```sh
git clone https://github.com/arielBiagio/SourcePad.git
cd SourcePad
npm ci
```

Copy `.env.example` to `.env`. In PowerShell:

```powershell
Copy-Item .env.example .env
```

### Environment

Replace the fictional values below with your own configuration. Set `AUTH_PROVIDER=supabase` explicitly: the supplied example file defaults to legacy mode.

```dotenv
AUTH_PROVIDER=supabase
PORT=3000
APP_URL=http://localhost:3000

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_with_your_key

OPENROUTER_API_KEY=replace_with_your_openrouter_key
OPENROUTER_CHAT_MODEL=qwen/qwen3.8-flash

MAX_UPLOAD_BYTES=10485760
```

`SUPABASE_ANON_KEY` is supported as an alternative for projects using a legacy anon key. Do not use a service-role or secret key: application operations use the user's session and the configured RLS policies. `MAX_UPLOAD_BYTES` can lower the upload limit, but cannot raise it above 10 MiB.

### Supabase setup

In a new project's SQL Editor, run the files in `supabase/migrations/` once, in this order:

1. `202610160001_notebooks.sql`
2. `202610160002_documents.sql`
3. `202610160003_processing.sql`
4. `202610160004_embeddings.sql`
5. `202610160005_conversations.sql`

These create the tables, vector extension, private `notebook-sources` bucket, policies, and database functions. Existing installations should apply only migrations they have not already applied; server startup does not run them.

Enable email/password authentication and email confirmation. Set the Supabase Auth Site URL to `http://localhost:3000` and allow `http://localhost:3000/auth/callback` as a redirect URL. The default confirmation email is supported. Open its link in the browser used to register so the PKCE verifier is available; configure email delivery for your intended recipients.

### Start and use

```sh
npm start
```

Open [localhost:3000](http://localhost:3000). Pages are available at `/auth.html`, `/notebooks.html`, and `/index.html`. No separate frontend server is needed.

Create a notebook, upload a source, then open **Detalles y opciones** to process and index it. Once indexing completes, ask a question in that notebook.

| Command | Purpose |
| --- | --- |
| `npm start` | Build the frontend CSS and start Express |
| `npm run build` | Generate the Tailwind CSS asset |
| `npm test` | Run the Node test suite |
| `npx playwright install chromium` | Install the browser required for E2E tests |
| `npm run test:e2e` | Run the configured desktop and mobile browser suites |

For legacy general-chat authentication, set `AUTH_PROVIDER=legacy`, supply a random `BETTER_AUTH_SECRET` of at least 32 characters, set `BETTER_AUTH_URL` to the application's origin, and run `npm run auth:migrate` before starting. Legacy and Supabase accounts are independent.

## Deployment

Deploy the repository as a **Node.js web service**, not a static-only site. No hosting-specific deployment manifest is included.

- Install with `npm ci --include=dev`; the CSS build depends on development packages. Start with `npm start`, which builds CSS before launching the server.
- Set the environment variables on the host. Use the public HTTPS origin for `APP_URL` and let the hosting platform supply `PORT`.
- Apply the Supabase migrations separately and update its Auth Site URL and callback allowlist to match the deployed origin. Configure email delivery.
- Preserve streamed responses: disable proxy buffering and allow enough request time for extraction, indexing batches, and generation.
- Use `/api/health` for server liveness. It does not check database or AI-provider availability.

In Supabase mode, durable application data and originals live in Supabase. The optional legacy mode writes a local SQLite database and needs persistent storage. Rate and concurrency limits are process-local; multiple instances would need coordinated controls.

## Current scope

- Scanned PDFs require OCR, which is not implemented. Multi-column layouts and tables may lose reading order during text extraction.
- Retrieval is limited to the selected chunks, not an exhaustive review of the document. Answer quality still depends on extraction, retrieval, and the model.
- Notebook summaries, study guides, notes/connections, password recovery, and Google sign-in are not implemented. Future-tool entries are interface placeholders.
- There is no persistent background queue, distributed rate limiter, or global AI budget controller.
