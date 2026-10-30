# Sarvam Document AI: prescription reading

## What the code does (matches the current official docs, checked in an earlier session)
1. The browser uploads the file to the `extract-prescription` Edge Function (or the local dev API). Allowed: PDF, PNG, JPG/JPEG, up to 10 MB (Sarvam allows more; the app caps it for phones). Sarvam allows up to 30 pages.
2. The function checks the signed-in user and that the chosen family member belongs to that account, rejects a file already uploaded for that person, stores the original in the private `prescriptions` bucket, and creates a Sarvam job: `POST {base}/doc-ai/v1/job/parse` (multipart: `file`, `language` as a BCP-47 code such as `hi-IN` / `en-IN`, `output_format`), header `api-subscription-key`.
3. The browser polls `extraction-job` with exponential backoff for up to about 150 seconds; the function polls `GET /doc-ai/v1/job/{id}/status`. States handled: pending, running, completed, partially completed, failed, rejected; 429/503 keep waiting; a job older than 10 minutes becomes "timed out".
4. When complete, `GET /doc-ai/v1/job/{id}/download-url` returns a plain URL (no key is sent to it) for a **ZIP**. The code unzips it, ignores `manifest.json` and `metadata/`, reads the Markdown (or HTML/JSON) file and converts it to text. The API does not return medicine objects; there is no such field.
5. A conservative parser reads only what is written (name, strength, dose, `1-0-1` / OD / BD / TDS notation, explicit times, before/after food, days/weeks) and **flags** everything else (timing unclear, frequency unclear, duration unclear, exact time needed, low confidence). It never invents a dose, frequency or schedule.
6. Review screen: every field is editable; the original text can be compared; nothing is active until the user confirms and activates.
7. Cancel only stops tracking. Sarvam has no documented cancel call.

## Note on `digitise`
The task brief named `POST /doc-ai/v1/job/digitise`. Its documentation pages no longer exist; the same OCR operation is documented as **parse**. The path is configurable: set `SARVAM_DOC_JOB_PATH=digitise` if your account still needs it.

## Configure
- Production: `supabase secrets set SARVAM_API_KEY=…` (see `DEPLOYMENT.md`).
- Local, no Supabase: `cp app/.env.server.example app/.env.server.local`, set `SARVAM_API_KEY`, then in two terminals `cd app && npm run dev:api` and `VITE_LOCAL_API=true npm run dev`. The key stays in the Node process; the browser only talks to `127.0.0.1`.
- Real-key check without the UI: `cd app && SARVAM_API_KEY=… npm run sarvam:smoke -- path/to/file.pdf hi-IN`.

## Status
Verified only against a **fake Sarvam server** that follows the documented protocol (`supabase/tests/sarvam.test.ts`, `app/e2e/sarvam-flow.mjs`). Not run against the live API: no key was available. OCR quality on handwriting is Sarvam's, not ours; unclear text is flagged for review instead of being guessed.
