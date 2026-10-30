// POST { action: 'status' | 'cancel', jobId }  →  advances (status) or cancels the caller's own reading job.
import { unzipSync } from 'npm:fflate@0.8.3'
import { corsHeaders, fail, json, requireUser } from '../_shared/http.ts'
import { SarvamDocAi } from '../_shared/sarvam.ts'
import { ServiceError, advanceExtraction, cancelExtraction, publicJob } from '../_shared/extraction-service.ts'
import { supabaseJobStore } from '../_shared/supabase-job-store.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'POST only')
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who

  let body: { action?: string; jobId?: string }
  try { body = await req.json() } catch { return fail(400, 'Expected JSON') }
  if (!body.jobId || typeof body.jobId !== 'string') return fail(400, 'Missing jobId')

  try {
    const deps = {
      sarvam: new SarvamDocAi({ apiKey: Deno.env.get('SARVAM_API_KEY'), baseUrl: Deno.env.get('SARVAM_BASE_URL'), jobPath: Deno.env.get('SARVAM_DOC_JOB_PATH') }),
      jobs: supabaseJobStore(db), unzip: unzipSync,
    }
    const job = body.action === 'cancel' ? await cancelExtraction(deps, body.jobId, user.id) : await advanceExtraction(deps, body.jobId, user.id)
    return json({ job: publicJob(job) })
  } catch (e) {
    if (e instanceof ServiceError) return json({ error: e.message, code: e.code, retryAfterSec: e.retryAfterSec }, e.status || 500)
    if ((e as { code?: string }).code === 'missing_credentials') return json({ error: (e as Error).message, code: 'missing_credentials' }, 503)
    console.error('extraction-job failed')
    return fail(500, 'Could not check the reading job.')
  }
})
