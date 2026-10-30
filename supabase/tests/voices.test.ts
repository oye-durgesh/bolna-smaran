/** Mom/Dad voice mapping and the ElevenLabs server calls, against a FAKE ElevenLabs (records which voice ID each request used). */
import { describe, expect, it } from 'vitest'
import { resolveVoice, VOICE_ENV, voiceFailureFromStatus } from '../functions/_shared/voices.ts'
import { agentForRelationship, startProfileSession, synthesize } from '../functions/_shared/elevenlabs.ts'
import type { ProfileRow } from '../functions/_shared/elevenlabs.ts'

const MOM = 'MomVoiceId0000000001', DAD = 'DadVoiceId0000000002', DEF = 'DefVoiceId0000000003'
const env = (o: Record<string, string>) => (k: string) => o[k]
const full = { ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'agent_1', ELEVENLABS_VOICE_ID: DEF, ELEVENLABS_MOM_VOICE_ID: MOM, ELEVENLABS_DAD_VOICE_ID: DAD }

describe('persona → voice mapping', () => {
  it('uses separate environment variables for each persona', () => {
    expect(VOICE_ENV).toEqual({ default: 'ELEVENLABS_VOICE_ID', mom: 'ELEVENLABS_MOM_VOICE_ID', dad: 'ELEVENLABS_DAD_VOICE_ID' })
  })
  it('mom → mom, dad → dad, default → default, switching in both directions', () => {
    const e = env(full)
    const id = (p: string) => { const r = resolveVoice(p, e, true); return r.ok ? r.voiceId : r.code }
    expect([id('mom'), id('dad'), id('mom'), id('default'), id('dad')]).toEqual([MOM, DAD, MOM, DEF, DAD])
  })
  it('no selection means the default voice, never mom or dad', () => {
    expect(resolveVoice(undefined, env(full), true)).toMatchObject({ ok: true, persona: 'default', voiceId: DEF })
  })
  it('a missing voice ID fails for THAT persona and never borrows another one', () => {
    const e = env({ ...full, ELEVENLABS_DAD_VOICE_ID: '' })
    expect(resolveVoice('dad', e, true)).toMatchObject({ ok: false, code: 'voice_not_configured', persona: 'dad' })
    expect(resolveVoice('mom', e, true)).toMatchObject({ ok: true, voiceId: MOM })
    const e2 = env({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_MOM_VOICE_ID: MOM })
    expect(resolveVoice('dad', e2, true)).toMatchObject({ ok: false, code: 'voice_not_configured' })
    expect(resolveVoice('default', e2, true)).toMatchObject({ ok: false, code: 'voice_not_configured' })
  })
  it('rejects malformed IDs and unknown personas', () => {
    expect(resolveVoice('mom', env({ ELEVENLABS_MOM_VOICE_ID: 'not a valid id!' }), true)).toMatchObject({ ok: false, code: 'voice_invalid' })
    expect(resolveVoice('grandpa', env(full), true)).toMatchObject({ ok: false, code: 'bad_persona' })
  })
  it('mom/dad require recorded consent; the default voice does not', () => {
    expect(resolveVoice('mom', env(full), false)).toMatchObject({ ok: false, code: 'consent_required' })
    expect(resolveVoice('dad', env(full), false)).toMatchObject({ ok: false, code: 'consent_required' })
    expect(resolveVoice('default', env(full), false).ok).toBe(true)
  })
  it('maps ElevenLabs HTTP failures', () => {
    expect(voiceFailureFromStatus(404).code).toBe('voice_invalid'); expect(voiceFailureFromStatus(401).code).toBe('auth')
    expect(voiceFailureFromStatus(429)).toMatchObject({ code: 'rate_limit', http: 429 }); expect(voiceFailureFromStatus(500).code).toBe('unavailable')
  })
})

/** A fake ElevenLabs that records which voice each TTS request used and returns audio bytes unique to that voice. */
const fakeEleven = (status = 200) => {
  const seen: { voice: string; key: string | null; body: any }[] = []
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const tts = /\/v1\/text-to-speech\/([^/]+)$/.exec(u.pathname)
    if (tts) {
      seen.push({ voice: decodeURIComponent(tts[1]), key: (init.headers as Record<string, string>)['xi-api-key'], body: JSON.parse(String(init.body)) })
      return status === 200 ? new Response(new TextEncoder().encode('AUDIO:' + tts[1]), { status }) : new Response('{}', { status })
    }
    if (u.pathname === '/v1/convai/conversation/get-signed-url') return new Response(JSON.stringify({ signed_url: 'wss://example/' + u.searchParams.get('agent_id') }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { f, seen }
}

describe('server TTS uses the intended voice', () => {
  it('each selection hits ElevenLabs with exactly its own voice ID and returns that voice’s audio', async () => {
    const { f, seen } = fakeEleven()
    const out: string[] = []
    for (const p of ['mom', 'dad', 'dad', 'mom', 'default']) {
      const r = await synthesize(env(full), { text: 'hello', persona: p, consent: true }, f)
      expect(r.ok).toBe(true)
      if (r.ok) { expect(r.persona).toBe(p); out.push(await r.audio.text()) }
    }
    expect(seen.map((s) => s.voice)).toEqual([MOM, DAD, DAD, MOM, DEF])
    expect(out).toEqual([`AUDIO:${MOM}`, `AUDIO:${DAD}`, `AUDIO:${DAD}`, `AUDIO:${MOM}`, `AUDIO:${DEF}`])
    expect(seen.every((s) => s.key === 'k')).toBe(true)
  })
  it('does not call ElevenLabs at all when the selected voice is missing or consent is absent', async () => {
    const { f, seen } = fakeEleven()
    expect(await synthesize(env({ ...full, ELEVENLABS_MOM_VOICE_ID: '' }), { text: 'x', persona: 'mom', consent: true }, f)).toMatchObject({ ok: false, status: 503, body: { code: 'voice_not_configured' } })
    expect(await synthesize(env(full), { text: 'x', persona: 'dad', consent: false }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'consent_required' } })
    expect(await synthesize(env({}), { text: 'x', persona: 'mom', consent: true }, f)).toMatchObject({ ok: false, body: { code: 'missing_credentials' } })
    expect(seen).toHaveLength(0)
  })
  it('API and network failures are clear errors, never another voice', async () => {
    const bad = fakeEleven(404)
    expect(await synthesize(env(full), { text: 'x', persona: 'mom', consent: true }, bad.f)).toMatchObject({ ok: false, body: { code: 'voice_invalid', persona: 'mom' } })
    expect(bad.seen.map((s) => s.voice)).toEqual([MOM])
    const down = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await synthesize(env(full), { text: 'x', persona: 'dad', consent: true }, down)).toMatchObject({ ok: false, status: 502, body: { code: 'unavailable', persona: 'dad' } })
    expect(await synthesize(env(full), { text: 'x', persona: 'dad', consent: true }, fakeEleven(429).f)).toMatchObject({ ok: false, status: 429, body: { code: 'rate_limit' } })
  })
})

describe('separate Mummy and Papa agents', () => {
  const MUM = 'agent_mummy_0001', PAP = 'agent_papa_00002'
  const e2 = { ELEVENLABS_API_KEY: 'shared-key', MUMMY_ELEVENLABS_AGENT_ID: MUM, PAPA_ELEVENLABS_AGENT_ID: PAP }
  const calls: Array<{ agent: string | null; key: string | null }> = []
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url); calls.push({ agent: u.searchParams.get('agent_id'), key: (init.headers as Record<string, string>)['xi-api-key'] })
    return new Response(JSON.stringify({ signed_url: `wss://example/${u.searchParams.get('agent_id')}` }), { status: 200 })
  }) as unknown as typeof fetch
  // Stands in for row-level security: each caller can read only the profiles it was given.
  const db = (rows: Record<string, ProfileRow>) => async (id: string) => rows[id] ?? null
  const rows = { mum: { id: 'mum', relationship: 'mother', active: true }, pap: { id: 'pap', relationship: 'father', active: true }, me: { id: 'me', relationship: 'self', active: true } }

  it('1-2. Mummy’s profile starts Mummy’s agent and Papa’s starts Papa’s, with the one shared key', async () => {
    calls.length = 0
    const a = await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db(rows) }, f)
    const b = await startProfileSession(env(e2), { personId: 'pap', consent: true, lookup: db(rows) }, f)
    expect(a).toMatchObject({ ok: true, agent: 'mummy', personId: 'mum', signedUrl: `wss://example/${MUM}` })
    expect(b).toMatchObject({ ok: true, agent: 'papa', personId: 'pap', signedUrl: `wss://example/${PAP}` })
    expect(calls).toEqual([{ agent: MUM, key: 'shared-key' }, { agent: PAP, key: 'shared-key' }])
  })
  it('7. switching back and forth always picks the agent of the profile being used', async () => {
    calls.length = 0
    for (const id of ['mum', 'pap', 'pap', 'mum']) await startProfileSession(env(e2), { personId: id, consent: true, lookup: db(rows) }, f)
    expect(calls.map((c) => c.agent)).toEqual([MUM, PAP, PAP, MUM])
  })
  it('3-4. a caller who cannot read a profile gets nothing, and no request goes to ElevenLabs', async () => {
    calls.length = 0
    const onlyMum = db({ mum: rows.mum })
    expect(await startProfileSession(env(e2), { personId: 'pap', consent: true, lookup: onlyMum }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'forbidden' } })
    const onlyPap = db({ pap: rows.pap })
    expect(await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: onlyPap }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'forbidden' } })
    expect(await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db({ mum: { ...rows.mum, active: false } }) }, f)).toMatchObject({ ok: false, status: 403 })
    expect(calls).toEqual([])
  })
  it('the agent follows the stored relationship, not anything the request says', async () => {
    // even if the browser claims to be Papa, the row for this id says mother
    const r = await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db(rows) }, f)
    expect(r).toMatchObject({ agent: 'mummy' })
    expect(agentForRelationship('mother')).toBe('mummy'); expect(agentForRelationship('father')).toBe('papa')
    expect(agentForRelationship('self')).toBeNull(); expect(agentForRelationship('other')).toBeNull()
    expect(await startProfileSession(env(e2), { personId: 'me', consent: true, lookup: db(rows) }, f)).toMatchObject({ ok: false, body: { code: 'no_agent_for_profile' } })
  })
  it('5. missing settings give a clear error naming the variable, and never fall back to the other agent', async () => {
    calls.length = 0
    const noMum = await startProfileSession(env({ ...e2, MUMMY_ELEVENLABS_AGENT_ID: '' }), { personId: 'mum', consent: true, lookup: db(rows) }, f)
    expect(noMum).toMatchObject({ ok: false, status: 503, body: { code: 'agent_not_configured' } })
    expect((noMum as { body: { error: string } }).body.error).toContain('MUMMY_ELEVENLABS_AGENT_ID')
    const noPap = await startProfileSession(env({ ...e2, PAPA_ELEVENLABS_AGENT_ID: '' }), { personId: 'pap', consent: true, lookup: db(rows) }, f)
    expect((noPap as { body: { error: string } }).body.error).toContain('PAPA_ELEVENLABS_AGENT_ID')
    expect(await startProfileSession(env({ ...e2, ELEVENLABS_API_KEY: '' }), { personId: 'pap', consent: true, lookup: db(rows) }, f)).toMatchObject({ ok: false, body: { code: 'missing_credentials' } })
    expect(calls).toEqual([])
    // Papa still works when only Mummy's is missing
    expect(await startProfileSession(env({ ...e2, MUMMY_ELEVENLABS_AGENT_ID: '' }), { personId: 'pap', consent: true, lookup: db(rows) }, f)).toMatchObject({ ok: true, agent: 'papa' })
  })
  it('refuses to start when both profiles are pointed at the same agent', async () => {
    expect(await startProfileSession(env({ ...e2, PAPA_ELEVENLABS_AGENT_ID: MUM }), { personId: 'pap', consent: true, lookup: db(rows) }, f)).toMatchObject({ ok: false, body: { code: 'agent_ids_identical' } })
  })
  it('maps ElevenLabs failures: unknown agent, rejected key, outage, network, empty answer', async () => {
    const st = (n: number) => (async () => new Response('{}', { status: n })) as unknown as typeof fetch
    const run = (fx: typeof fetch) => startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db(rows) }, fx)
    expect(await run(st(404))).toMatchObject({ ok: false, body: { code: 'agent_invalid' } })
    expect(await run(st(401))).toMatchObject({ ok: false, body: { code: 'auth' } })
    expect(await run(st(500))).toMatchObject({ ok: false, body: { code: 'unavailable' } })
    expect(await run((async () => { throw new Error('x') }) as unknown as typeof fetch)).toMatchObject({ ok: false, body: { code: 'unavailable' } })
    expect(await run((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch)).toMatchObject({ ok: false, body: { code: 'unavailable' } })
  })
  it('6. neither the API key nor an agent ID appears in anything returned to the browser', async () => {
    const ok = await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db(rows) }, f)
    const bad = await startProfileSession(env({ ...e2, MUMMY_ELEVENLABS_AGENT_ID: '' }), { personId: 'mum', consent: true, lookup: db(rows) }, f)
    for (const r of [ok, bad, await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db(rows) }, (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch)]) {
      expect(JSON.stringify(r)).not.toContain('shared-key')
    }
  })
  it('the cloned-voice consent guard still applies', async () => {
    expect(await startProfileSession(env({ ...e2, ELEVENLABS_AGENT_USES_CLONED_VOICE: 'true' }), { personId: 'mum', consent: false, lookup: db(rows) }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'consent_required' } })
  })
})
