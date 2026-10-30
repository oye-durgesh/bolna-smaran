// POST multipart { file, language }  →  stores the original, submits a Sarvam Document AI job and returns immediately with the job.
// The browser then polls `extraction-job`. The key (SARVAM_API_KEY) is read here only and never reaches the client.
import { unzipSync } from 'npm:fflate@0.8.3'
import { corsHeaders, fail, json, requireUser, audit } from '../_shared/http.ts'
import { SarvamDocAi, SarvamError } from '../_shared/sarvam.ts'
import { ServiceError, publicJob, submitExtraction } from '../_shared/extraction-service.ts'
import { validateUpload } from '../_shared/extraction-types.ts'
import { supabaseJobStore } from '../_shared/supabase-job-store.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'POST only')
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who

  let sarvam: SarvamDocAi
  try {
    sarvam = new SarvamDocAi({ apiKey: Deno.env.get('SARVAM_API_KEY'), baseUrl: Deno.env.get('SARVAM_BASE_URL'), jobPath: Deno.env.get('SARVAM_DOC_JOB_PATH') })
  } catch (e) {
    return json({ error: (e as Error).message, code: 'missing_credentials' }, 503)
  }

  let form: FormData
  try { form = await req.formData() } catch { return json({ error: 'Expected multipart form data', code: 'bad_request' }, 400) }
  const file = form.get('file')
  const language = String(form.get('language') ?? 'en-IN')
  const personId = String(form.get('personId') ?? '')
  const docType = String(form.get('documentType') ?? 'prescription')
  if (!['prescription', 'lab_report', 'blood_sugar_report', 'bp_log', 'discharge_summary', 'appointment_note', 'other'].includes(docType)) return json({ error: 'Unknown document type', code: 'bad_request' }, 400)
  // the document belongs to a family member of THIS account; anything else (another account, archived, unknown) is refused before any upload
  const { data: person } = await db.from('care_recipients').select('id, owner_id, active').eq('id', personId).maybeSingle()
  if (!person || person.owner_id !== user.id || !person.active) return json({ error: 'You do not have permission to upload for this person.', code: 'permission_denied' }, 403)
  if (!(file instanceof File)) return json({ error: 'Missing file', code: 'invalid_file' }, 400)
  const bad = validateUpload({ name: file.name, type: file.type, size: file.size })
  if (bad) return json({ error: bad.message, code: bad.code }, bad.code === 'too_large' ? 413 : 415)

  // duplicate upload: the same file for the same person is not stored twice
  const hashBuf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const contentHash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const { data: dup } = await db.from('prescription_documents').select('id, extraction_job_id').eq('person_id', personId).eq('content_hash', contentHash).maybeSingle()
  if (dup) return json({ error: 'This file was already uploaded for this person.', code: 'duplicate_upload', documentId: dup.id, jobId: dup.extraction_job_id ?? null }, 409)

  // keep the original (private bucket; folder = user id)
  const docId = crypto.randomUUID()
  const path = `${user.id}/${docId}`
  const up = await db.storage.from('prescriptions').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (up.error) return json({ error: 'Could not store the prescription.', code: 'unavailable' }, 500)
  await db.from('prescription_documents').insert({ id: docId, owner_id: user.id, person_id: personId, document_type: docType, content_hash: contentHash, storage_path: path, file_name: file.name.slice(0, 200), mime: file.type || 'application/octet-stream', size_bytes: file.size, extraction_provider: 'sarvam' })

  try {
    const job = await submitExtraction(
      { sarvam, jobs: supabaseJobStore(db), unzip: unzipSync },
      { ownerId: user.id, file, fileName: file.name, mime: file.type || 'application/octet-stream', size: file.size, language },
    )
    await db.from('extraction_jobs').update({ document_id: docId }).eq('id', job.id)
    await db.from('prescription_documents').update({ extraction_job_id: job.id }).eq('id', docId)
    await audit(db, user.id, user.id, 'prescription_submitted', `job=${job.id}`)
    return json({ job: publicJob(job) })
  } catch (e) {
    if (e instanceof ServiceError) return json({ error: e.message, code: e.code, retryAfterSec: e.retryAfterSec }, e.status === 0 ? 502 : e.status, e.retryAfterSec ? { 'Retry-After': String(e.retryAfterSec) } : {})
    if (e instanceof SarvamError) return json({ error: e.message, code: e.code }, 502)
    console.error('extract-prescription failed') // no document content or key in logs
    return json({ error: 'Something went wrong starting the reading.', code: 'failed' }, 500)
  }
})
