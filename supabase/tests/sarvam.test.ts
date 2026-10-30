/**
 * Sarvam Document AI integration tests against a local FAKE Sarvam server that follows the documented protocol
 * (parse → status → download-url → ZIP). This proves our client/service logic, not Sarvam's OCR quality — see docs for the live smoke test.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SarvamDocAi, SarvamError, errorFromResponse } from '../functions/_shared/sarvam.ts'
import { advanceExtraction, cancelExtraction, memoryJobStore, ServiceError, submitExtraction, publicJob } from '../functions/_shared/extraction-service.ts'
import { validateUpload } from '../functions/_shared/extraction-types.ts'
import { htmlToText, jsonToText, markdownToText, primaryToText, readPrimaryFile } from '../functions/_shared/ocr-output.ts'
import { parsePrescriptionText } from '../functions/_shared/prescription-parser.ts'

const RX_MD = `# Dr. A. Sharma, MBBS
Reg No 12345 | Patient: Ramesh Kumar, 67 y

| Medicine | Dose | Frequency | Duration |
|---|---|---|---|
| Tab Metformin 500mg | 1 tab | BD after food | 30 days |
| Tab Amlodipine 5mg | 1 tab | OD morning | continue |

Tab Ecosprin 75 OD
Advice: Avoid sugar. Walk 30 minutes daily.`

const zipOf = (md: string, extra: Record<string, string> = {}) =>
  zipSync({ 'manifest.json': strToU8('{"pages":1}'), 'rx.pdf/rx.md': strToU8(md), 'rx.pdf/metadata/page_001.json': strToU8('{"text":"IGNORE ME"}'), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])) })

// ───────── fake Sarvam ─────────
interface Behavior { statuses: Array<'pending' | 'running' | 'completed' | 'partially_completed' | 'failed' | 'rejected'>; submitStatus?: number; statusHttp?: number[]; zip?: Uint8Array; pagesFailed?: number }
let server: Server, base = ''
let beh: Behavior
const seen: { submit?: { headers: Record<string, unknown>; body: string }; keyOnDownload?: unknown; polls: number } = { polls: 0 }

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/doc-ai/v1/job/parse') {
        seen.submit = { headers: req.headers, body: Buffer.concat(chunks).toString('latin1') }
        if (beh.submitStatus) { res.writeHead(beh.submitStatus, { 'Retry-After': '17' }); return res.end('{"error":"x"}') }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ job_id: 'sv_1', status: 'pending' }))
      }
      if (url === '/doc-ai/v1/job/sv_1/status') {
        const http = beh.statusHttp?.[seen.polls]
        const st = beh.statuses[Math.min(seen.polls, beh.statuses.length - 1)]
        seen.polls++
        if (http) { res.writeHead(http, { 'Retry-After': '3' }); return res.end('{}') }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ job_id: 'sv_1', status: st, usage: { pages_total: 2, pages_processed: st === 'pending' ? 0 : 2, pages_succeeded: 2 - (beh.pagesFailed ?? 0), pages_failed: beh.pagesFailed ?? 0 } }))
      }
      if (url === '/doc-ai/v1/job/sv_1/download-url') {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ method: 'GET', url: `${base}/files/out.zip` }))
      }
      if (url === '/files/out.zip') { seen.keyOnDownload = req.headers['api-subscription-key']; res.writeHead(200); return res.end(Buffer.from(beh.zip ?? zipOf(RX_MD))) }
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close() })
beforeEach(() => { beh = { statuses: ['pending', 'running', 'completed'] }; seen.polls = 0; seen.submit = undefined; seen.keyOnDownload = undefined })

const mk = (opts: Partial<{ now: () => Date; maxJobAgeMs: number; apiKey: string | undefined }> = {}) => {
  const jobs = memoryJobStore()
  const sarvam = new SarvamDocAi({ apiKey: 'test-key' in opts ? undefined : (opts.apiKey ?? 'test-key'), baseUrl: base })
  return { deps: { sarvam, jobs, unzip: unzipSync, ...opts }, jobs }
}
const input = { ownerId: 'u1', file: new Blob([new Uint8Array([1, 2, 3, 4])]), fileName: 'rx.pdf', mime: 'application/pdf', size: 4, language: 'hi-IN' }

describe('file validation', () => {
  it('accepts pdf/png/jpg and rejects everything else, empty and oversize files', () => {
    expect(validateUpload({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeNull()
    expect(validateUpload({ name: 'a.PNG', type: 'image/png', size: 10 })).toBeNull()
    expect(validateUpload({ name: 'a.jpeg', type: 'image/jpeg', size: 10 })).toBeNull()
    expect(validateUpload({ name: 'a.jpg', type: '', size: 10 })).toBeNull() // some browsers omit the type
    expect(validateUpload({ name: 'a.webp', type: 'image/webp', size: 10 })?.code).toBe('unsupported_type')
    expect(validateUpload({ name: 'a.txt', type: 'text/plain', size: 10 })?.code).toBe('unsupported_type')
    expect(validateUpload({ name: 'a.pdf', type: 'application/pdf', size: 0 })?.code).toBe('invalid_file')
    expect(validateUpload({ name: 'a.pdf', type: 'application/pdf', size: 11 * 1048576 })?.code).toBe('too_large')
  })
})

describe('Sarvam client protocol', () => {
  it('sends language + output_format (not language_code), the key header, and never sends the key to the download URL', async () => {
    const { deps } = mk()
    const job = await submitExtraction(deps, input)
    expect(job.sarvamJobId).toBe('sv_1')
    expect(seen.submit!.headers['api-subscription-key']).toBe('test-key')
    expect(seen.submit!.body).toMatch(/name="language"\r\n\r\nhi-IN/)
    expect(seen.submit!.body).toMatch(/name="output_format"\r\n\r\nmd/)
    expect(seen.submit!.body).not.toMatch(/language_code/)
    expect(seen.submit!.body).toMatch(/name="file"; filename="rx.pdf"/)
    let j = job
    for (let i = 0; i < 4 && j.status !== 'completed'; i++) j = await advanceExtraction(deps, job.id, 'u1')
    expect(j.status).toBe('completed')
    expect(seen.keyOnDownload).toBeUndefined()
  })
  it('refuses to run without a key', () => {
    expect(() => new SarvamDocAi({ apiKey: undefined })).toThrowError(/SARVAM_API_KEY/)
  })
  it('maps every documented HTTP error to a clear code', () => {
    const c = (s: number, b = '') => errorFromResponse(s, b, new Headers({ 'retry-after': '9' }))
    expect(c(429)).toMatchObject({ code: 'rate_limit', retryAfterSec: 9 })
    expect(c(402).code).toBe('billing'); expect(c(403).code).toBe('billing'); expect(c(401).code).toBe('auth')
    expect(c(413).code).toBe('too_large'); expect(c(422).code).toBe('invalid_file'); expect(c(404).code).toBe('not_found')
    expect(c(400, 'page limit exceeded').code).toBe('too_many_pages'); expect(c(400, 'invalid language').code).toBe('bad_request')
    expect(c(503).code).toBe('unavailable'); expect(c(500).code).toBe('unavailable')
  })
  it('surfaces submit-time API errors as service errors with retry hints, and records the failed job', async () => {
    for (const [status, code] of [[429, 'rate_limit'], [402, 'billing'], [413, 'too_large'], [422, 'invalid_file']] as const) {
      beh = { statuses: ['pending'], submitStatus: status }
      const { deps, jobs } = mk()
      await expect(submitExtraction(deps, input)).rejects.toMatchObject({ code })
      expect(jobs.all()[0]).toMatchObject({ status: 'failed', errorCode: code })
    }
    beh = { statuses: ['pending'], submitStatus: 429 }
    await expect(submitExtraction(mk().deps, input)).rejects.toMatchObject({ retryAfterSec: 17 })
  })
  it('rejects bad input before calling Sarvam', async () => {
    const { deps } = mk()
    await expect(submitExtraction(deps, { ...input, fileName: 'x.txt', mime: 'text/plain' })).rejects.toBeInstanceOf(ServiceError)
    await expect(submitExtraction(deps, { ...input, language: 'xx-YY' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(seen.submit).toBeUndefined()
  })
})

describe('job polling', () => {
  it('walks pending → running → completed and exposes page progress', async () => {
    const { deps } = mk()
    const job = await submitExtraction(deps, input)
    const a = await advanceExtraction(deps, job.id, 'u1'); expect(a.status).toBe('running')
    const b = await advanceExtraction(deps, job.id, 'u1'); expect(b.status).toBe('running'); expect(b.pages).toMatchObject({ total: 2 })
    const c = await advanceExtraction(deps, job.id, 'u1'); expect(c.status).toBe('completed'); expect(c.result?.medicines.length).toBeGreaterThan(0)
    const again = await advanceExtraction(deps, job.id, 'u1'); expect(again.status).toBe('completed'); expect(seen.polls).toBe(3) // terminal jobs are not polled again
  })
  it('a rate-limited status check keeps the job running instead of failing it', async () => {
    beh = { statuses: ['running', 'running', 'completed'], statusHttp: [429] }
    const { deps } = mk()
    const job = await submitExtraction(deps, input)
    const a = await advanceExtraction(deps, job.id, 'u1')
    expect(a.status).toBe('submitted'); expect(a.retryAfterSec).toBe(3)
  })
  it('times out a job that never finishes', async () => {
    beh = { statuses: ['running'] }
    let t = Date.parse('2026-01-01T00:00:00Z')
    const { deps } = mk({ now: () => new Date(t), maxJobAgeMs: 60_000 })
    const job = await submitExtraction(deps, input)
    expect((await advanceExtraction(deps, job.id, 'u1')).status).toBe('running')
    t += 61_000
    const j = await advanceExtraction(deps, job.id, 'u1')
    expect(j).toMatchObject({ status: 'timed_out', errorCode: 'timeout' })
  })
  it('handles failed and rejected jobs', async () => {
    for (const st of ['failed', 'rejected'] as const) {
      beh = { statuses: [st] }
      const { deps } = mk(); const job = await submitExtraction(deps, input)
      const j = await advanceExtraction(deps, job.id, 'u1')
      expect(j).toMatchObject({ status: st, errorCode: st }); expect(j.result).toBeUndefined()
    }
  })
  it('partially_completed still returns output with a page warning and is marked partial', async () => {
    beh = { statuses: ['partially_completed'], pagesFailed: 1 }
    const { deps } = mk(); const job = await submitExtraction(deps, input)
    const j = await advanceExtraction(deps, job.id, 'u1')
    expect(j.status).toBe('partially_completed'); expect(j.result?.outcome).toBe('partial')
    expect(j.result?.warnings.join(' ')).toMatch(/page.*could not be read/)
  })
  it('cancellation stops tracking; the result is ignored; other users cannot see the job', async () => {
    const { deps } = mk(); const job = await submitExtraction(deps, input)
    expect((await cancelExtraction(deps, job.id, 'u1')).status).toBe('cancelled')
    expect((await advanceExtraction(deps, job.id, 'u1')).status).toBe('cancelled')
    await expect(advanceExtraction(deps, job.id, 'someone-else')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('never exposes the owner or the Sarvam job id to the browser', async () => {
    const { deps } = mk(); const job = await submitExtraction(deps, input)
    expect(Object.keys(publicJob(job))).not.toContain('ownerId'); expect(Object.keys(publicJob(job))).not.toContain('sarvamJobId')
  })
  it('a document with no medicines fails with no_medicines but keeps the extracted text for comparison', async () => {
    beh = { statuses: ['completed'], zip: zipOf('# Lab report\nHemoglobin 13.5 g/dL\nGlucose 98 mg/dL') }
    const { deps } = mk(); const job = await submitExtraction(deps, input)
    const j = await advanceExtraction(deps, job.id, 'u1')
    expect(j).toMatchObject({ status: 'failed', errorCode: 'no_medicines' }); expect(j.result?.rawText).toMatch(/Hemoglobin/)
  })
  it('a corrupt or empty ZIP is reported, not guessed at', async () => {
    beh = { statuses: ['completed'], zip: new Uint8Array([1, 2, 3]) }
    const { deps } = mk(); const job = await submitExtraction(deps, input)
    expect(await advanceExtraction(deps, job.id, 'u1')).toMatchObject({ status: 'failed', errorCode: 'no_output' })
  })
})

describe('output parsing (ZIP → text)', () => {
  it('reads the primary file, ignoring manifest.json and metadata/*', () => {
    const p = readPrimaryFile(zipOf(RX_MD), unzipSync, 'md')
    expect(p.name).toBe('rx.pdf/rx.md'); expect(p.text).not.toMatch(/IGNORE ME/)
  })
  it('falls back to another format if the requested one is absent', () => {
    const zip = zipSync({ 'manifest.json': strToU8('{}'), 'd/d.html': strToU8('<p>Tab Metformin 500mg BD</p>') })
    expect(readPrimaryFile(zip, unzipSync, 'md').format).toBe('html')
  })
  it('converts html tables, markdown tables and json blocks to lines', () => {
    expect(htmlToText('<table><tr><th>Medicine</th><th>Dose</th></tr><tr><td>Tab Metformin 500mg</td><td>1 tab BD</td></tr></table>')).toContain('Tab Metformin 500mg | 1 tab BD')
    expect(markdownToText('| A | B |\n|---|---|\n| x | y |')).toBe('A | B\nx | y')
    expect(jsonToText(JSON.stringify({ pages: [{ blocks: [{ text: 'Tab Metformin 500mg', tag: 'p', bbox: [1, 2, 3, 4] }, { text: 'BD', tag: 'p' }] }] }))).toBe('Tab Metformin 500mg\nBD')
    expect(primaryToText({ name: 'x', format: 'html', text: '<p>a&amp;b</p>' })).toBe('a&b')
  })
})

describe('medicine draft: only what is written', () => {
  const run = (t: string) => parsePrescriptionText(t)
  it('reads a prescription table and free lines without inventing fields', () => {
    const r = run(markdownToText(RX_MD))
    const by = (n: string) => r.medicines.find((m) => m.name.startsWith(n))!
    expect(by('Metformin')).toMatchObject({ strength: '500mg', dose: '1 tablet', frequency: 'twice', food: 'after', duration: 'course', courseDays: 30 })
    expect(by('Amlodipine')).toMatchObject({ strength: '5mg', frequency: 'once', duration: 'ongoing', timeOfDay: ['morning'] })
    expect(by('Amlodipine').times).toEqual([])                       // "morning" is not a clock time
    expect(by('Amlodipine').flags).toEqual(expect.arrayContaining(['exact_time_needed', 'food_missing']))
    expect(r.otherInstructions.join(' ')).toMatch(/Avoid sugar/)
  })
  it('marks missing/ambiguous fields for review instead of guessing', () => {
    const m = run('Tab Ecosprin 75 OD').medicines[0]
    expect(m.strength).toBe(''); expect(m.flags).toEqual(expect.arrayContaining(['strength_missing', 'dose_missing', 'food_missing', 'duration_unclear', 'timing_unclear']))
    expect(m.food).toBeNull(); expect(m.times).toEqual([]); expect(m.duration).toBeNull()
  })
  it('does not turn "1-0-1" into a clock time, and keeps unequal amounts for review', () => {
    const a = run('Tab Metformin 500mg 1-0-1 after food').medicines[0]
    expect(a).toMatchObject({ frequency: 'twice', dose: '1 tablet', timeOfDay: ['morning', 'night'] }); expect(a.times).toEqual([])
    const b = run('Tab Foo 10mg 1-0-2').medicines[0]
    expect(b.dose).toBe(''); expect(b.notes).toMatch(/check the dose/i)
  })
  it('treats SOS as no fixed schedule, and months as unclear', () => {
    const s = run('Tab Paracetamol 650mg SOS').medicines[0]
    expect(s.flags).toContain('as_needed'); expect(s.notes).toMatch(/no fixed schedule/)
    const m = run('Tab Vitamin D 60000 IU weekly x 2 months').medicines[0]
    expect(m.flags).toContain('duration_unclear'); expect(m.courseDays).toBeUndefined()
  })
  it('records written clock times only', () => {
    expect(run('Tab Thyroxine 50mcg OD at 6 am before food').medicines[0]).toMatchObject({ times: ['06:00'], food: 'before' })
  })
  it('flags noisy OCR as low confidence', () => {
    const m = run('Tab M?tf�rmin 500mg BD').medicines[0]
    expect(m.lowConfidence).toBe(true); expect(m.flags).toContain('low_confidence')
  })
  it('understands Hindi instruction words next to English drug names', () => {
    const m = run('Tab Metformin 500mg दिन में दो बार खाने के बाद 10 दिन').medicines[0]
    expect(m).toMatchObject({ frequency: 'twice', food: 'after', courseDays: 10 })
  })
  it('ignores headers, patient lines and duplicates', () => {
    const r = run('Dr. Sharma\nPatient: Ramesh 67\nTab Metformin 500mg BD\nTab Metformin 500mg BD')
    expect(r.medicines).toHaveLength(1); expect(r.warnings.join(' ')).toMatch(/duplicate/)
  })
  it('returns nothing for a non-prescription', () => {
    expect(run('Hemoglobin 13.5 g/dL\nGlucose 98 mg/dL').medicines).toEqual([])
  })
})
describe('SarvamError', () => { it('is an Error with a code', () => { expect(new SarvamError('timeout', 'x')).toBeInstanceOf(Error) }) })
