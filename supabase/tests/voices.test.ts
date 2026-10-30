/** Mom/Dad voice mapping and the ElevenLabs server calls, against a FAKE ElevenLabs (records which voice ID each request used). */
import { describe, expect, it } from 'vitest'
import { isClonedVoiceCategory, resolveVoice, VOICE_ENV, voiceFailureFromStatus } from '../functions/_shared/voices.ts'
import { agentForRelationship, startProfileSession, synthesize, synthesizeForProfile } from '../functions/_shared/elevenlabs.ts'
import type { ProfileRow } from '../functions/_shared/elevenlabs.ts'

const MOM = 'MomVoiceId0000000001', DAD = 'DadVoiceId0000000002', DEF = 'DefVoiceId0000000003'
const MUM_AGENT = 'agent_mummy_0001', PAP_AGENT = 'agent_papa_00002'
const env = (o: Record<string, string>) => (k: string) => o[k]
const agents = { ELEVENLABS_API_KEY: 'k', MUMMY_ELEVENLABS_AGENT_ID: MUM_AGENT, PAPA_ELEVENLABS_AGENT_ID: PAP_AGENT, ELEVENLABS_VOICE_ID: DEF }
const full = { ...agents, ELEVENLABS_MOM_VOICE_ID: MOM, ELEVENLABS_DAD_VOICE_ID: DAD }

describe('persona → voice mapping', () => {
  it('keeps Voice ID env names documented, but mom/dad reminder TTS does not read those secrets', () => {
    expect(VOICE_ENV).toEqual({ default: 'ELEVENLABS_VOICE_ID', mom: 'ELEVENLABS_MOM_VOICE_ID', dad: 'ELEVENLABS_DAD_VOICE_ID' })
    expect(resolveVoice('mom', env(full), true)).toMatchObject({ ok: false, code: 'voice_not_configured', persona: 'mom' })
    expect(resolveVoice('dad', env(full), true)).toMatchObject({ ok: false, code: 'voice_not_configured', persona: 'dad' })
  })
  it('no selection means the default voice, never mom or dad', () => {
    expect(resolveVoice(undefined, env(full), true)).toMatchObject({ ok: true, persona: 'default', voiceId: DEF })
  })
  it('a missing default voice ID fails and never borrows mom or dad', () => {
    const e2 = env({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_MOM_VOICE_ID: MOM })
    expect(resolveVoice('default', e2, true)).toMatchObject({ ok: false, code: 'voice_not_configured' })
    expect(resolveVoice('dad', e2, true)).toMatchObject({ ok: false, code: 'voice_not_configured', persona: 'dad' })
  })
  it('rejects malformed default IDs and unknown personas', () => {
    expect(resolveVoice('default', env({ ELEVENLABS_VOICE_ID: 'not a valid id!' }), true)).toMatchObject({ ok: false, code: 'voice_invalid' })
    expect(resolveVoice('grandpa', env(full), true)).toMatchObject({ ok: false, code: 'bad_persona' })
  })
  it('licensed library voices do not require cloning consent; cloned categories do', () => {
    expect(isClonedVoiceCategory('premade')).toBe(false)
    expect(isClonedVoiceCategory('professional')).toBe(false)
    expect(isClonedVoiceCategory('generated')).toBe(false)
    expect(isClonedVoiceCategory('cloned')).toBe(true)
    expect(resolveVoice('default', env(full), false).ok).toBe(true)
  })
  it('maps ElevenLabs HTTP failures', () => {
    expect(voiceFailureFromStatus(404).code).toBe('voice_invalid'); expect(voiceFailureFromStatus(401).code).toBe('auth')
    expect(voiceFailureFromStatus(429)).toMatchObject({ code: 'rate_limit', http: 429 }); expect(voiceFailureFromStatus(500).code).toBe('unavailable')
  })
})

/** Fake ElevenLabs: agent GET returns a Voice ID per agent; TTS records which voice was used. */
const fakeEleven = (opts: { ttsStatus?: number; agentVoice?: Record<string, string | ''>; voiceCategory?: Record<string, string>; agentStatus?: number } = {}) => {
  const ttsStatus = opts.ttsStatus ?? 200
  const agentVoice = opts.agentVoice ?? { [MUM_AGENT]: MOM, [PAP_AGENT]: DAD }
  const voiceCategory = opts.voiceCategory ?? { [MOM]: 'premade', [DAD]: 'premade', [DEF]: 'premade' }
  const seen: { kind: string; id: string; key: string | null }[] = []
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const key = (init.headers as Record<string, string>)['xi-api-key']
    const agent = /\/v1\/convai\/agents\/([^/]+)$/.exec(u.pathname)
    if (agent) {
      const id = decodeURIComponent(agent[1])
      seen.push({ kind: 'agent', id, key })
      if (opts.agentStatus && opts.agentStatus !== 200) return new Response('{}', { status: opts.agentStatus })
      const voice_id = agentVoice[id]
      if (voice_id === undefined) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ conversation_config: { tts: voice_id === '' ? {} : { voice_id } } }), { status: 200 })
    }
    const voiceMeta = /\/v1\/voices\/([^/]+)$/.exec(u.pathname)
    if (voiceMeta && (!init.method || init.method === 'GET')) {
      const id = decodeURIComponent(voiceMeta[1])
      seen.push({ kind: 'voice', id, key })
      const cat = voiceCategory[id]
      if (!cat) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ category: cat, name: 'x' }), { status: 200 })
    }
    const tts = /\/v1\/text-to-speech\/([^/]+)$/.exec(u.pathname)
    if (tts) {
      seen.push({ kind: 'tts', id: decodeURIComponent(tts[1]), key })
      return ttsStatus === 200 ? new Response(new TextEncoder().encode('AUDIO:' + decodeURIComponent(tts[1])), { status: ttsStatus }) : new Response('{}', { status: ttsStatus })
    }
    if (u.pathname === '/v1/convai/conversation/get-signed-url') return new Response(JSON.stringify({ signed_url: 'wss://example/' + u.searchParams.get('agent_id') }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { f, seen }
}

describe('server TTS uses the agent’s configured voice', () => {
  it('Mummy and Papa each hit ElevenLabs TTS with their own agent Voice ID', async () => {
    const { f, seen } = fakeEleven()
    const out: string[] = []
    for (const p of ['mom', 'dad', 'dad', 'mom', 'default']) {
      const r = await synthesize(env(agents), { text: 'hello', persona: p, consent: false }, f)
      expect(r.ok).toBe(true)
      if (r.ok) { expect(r.persona).toBe(p); out.push(await r.audio.text()) }
    }
    expect(seen.filter((s) => s.kind === 'tts').map((s) => s.id)).toEqual([MOM, DAD, DAD, MOM, DEF])
    expect(out).toEqual([`AUDIO:${MOM}`, `AUDIO:${DAD}`, `AUDIO:${DAD}`, `AUDIO:${MOM}`, `AUDIO:${DEF}`])
    expect(seen.every((s) => s.key === 'k')).toBe(true)
    expect(JSON.stringify(seen.filter((s) => s.kind === 'agent'))).toContain(MUM_AGENT)
  })
  it('does not call TTS when the selected agent has no Voice ID, and never uses the other parent', async () => {
    const { f, seen } = fakeEleven({ agentVoice: { [MUM_AGENT]: '', [PAP_AGENT]: DAD } })
    expect(await synthesize(env(agents), { text: 'x', persona: 'mom', consent: true }, f)).toMatchObject({ ok: false, status: 503, body: { code: 'voice_not_configured', persona: 'mom' } })
    expect(seen.filter((s) => s.kind === 'tts')).toEqual([])
    const pap = await synthesize(env(agents), { text: 'x', persona: 'dad', consent: false }, f)
    expect(pap.ok).toBe(true)
    if (pap.ok) expect(await pap.audio.text()).toBe(`AUDIO:${DAD}`)
    expect(await synthesize(env({}), { text: 'x', persona: 'mom', consent: true }, f)).toMatchObject({ ok: false, body: { code: 'missing_credentials' } })
  })
  it('licensed premade voices work without cloning consent; cloned voices still require it', async () => {
    const licensed = fakeEleven({ voiceCategory: { [MOM]: 'premade', [DAD]: 'professional' } })
    expect((await synthesize(env(agents), { text: 'x', persona: 'mom', consent: false }, licensed.f)).ok).toBe(true)
    expect((await synthesize(env(agents), { text: 'x', persona: 'dad', consent: false }, licensed.f)).ok).toBe(true)
    const cloned = fakeEleven({ voiceCategory: { [MOM]: 'cloned', [DAD]: 'premade' } })
    expect(await synthesize(env(agents), { text: 'x', persona: 'mom', consent: false }, cloned.f)).toMatchObject({ ok: false, status: 403, body: { code: 'consent_required', persona: 'mom' } })
    expect((await synthesize(env(agents), { text: 'x', persona: 'mom', consent: true }, cloned.f)).ok).toBe(true)
    expect(cloned.seen.filter((s) => s.kind === 'tts' && s.id === DAD)).toEqual([])
  })
  it('API and network failures are clear errors, never another voice', async () => {
    const bad = fakeEleven({ ttsStatus: 404 })
    expect(await synthesize(env(agents), { text: 'x', persona: 'mom', consent: true }, bad.f)).toMatchObject({ ok: false, body: { code: 'voice_invalid', persona: 'mom' } })
    expect(bad.seen.filter((s) => s.kind === 'tts').map((s) => s.id)).toEqual([MOM])
    const down = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await synthesize(env(agents), { text: 'x', persona: 'dad', consent: true }, down)).toMatchObject({ ok: false, status: 502, body: { code: 'unavailable', persona: 'dad' } })
    expect(await synthesize(env(agents), { text: 'x', persona: 'dad', consent: true }, fakeEleven({ ttsStatus: 429 }).f)).toMatchObject({ ok: false, status: 429, body: { code: 'rate_limit' } })
    expect(await synthesize(env(agents), { text: 'x', persona: 'mom', consent: true }, fakeEleven({ agentStatus: 401 }).f)).toMatchObject({ ok: false, body: { code: 'auth', persona: 'mom' } })
    expect(await synthesize(env(agents), { text: 'x', persona: 'dad', consent: true }, fakeEleven({ agentStatus: 429 }).f)).toMatchObject({ ok: false, status: 429, body: { code: 'rate_limit' } })
  })
  it('never returns Agent IDs, Voice IDs or the API key in error or success payloads', async () => {
    const secret = 'el_secret_abc'
    const e = env({ ...agents, ELEVENLABS_API_KEY: secret })
    const { f } = fakeEleven({ agentVoice: { [MUM_AGENT]: '', [PAP_AGENT]: DAD } })
    const missing = await synthesize(e, { text: 'x', persona: 'mom', consent: true }, f)
    const ok = await synthesize(e, { text: 'x', persona: 'dad', consent: false }, f)
    for (const r of [missing, ok]) {
      const s = JSON.stringify(r.ok ? { persona: r.persona, status: 'ok' } : r)
      expect(s).not.toContain(secret)
      expect(s).not.toContain(MUM_AGENT)
      expect(s).not.toContain(PAP_AGENT)
      expect(s).not.toContain(MOM)
      expect(s).not.toContain(DAD)
    }
  })
})

describe('authorised family TTS never crosses parents', () => {
  const db = (rows: Record<string, ProfileRow>) => async (id: string) => rows[id] ?? null
  const rows = { mum: { id: 'mum', relationship: 'mother', active: true }, pap: { id: 'pap', relationship: 'father', active: true }, me: { id: 'me', relationship: 'self', active: true } }

  it('Mummy’s row uses Mummy’s agent voice and Papa’s row uses Papa’s, even if the client asked for the other persona', async () => {
    const { f, seen } = fakeEleven()
    const a = await synthesizeForProfile(env(agents), { text: 'hi', personId: 'mum', consent: false, lookup: db(rows) }, f)
    const b = await synthesizeForProfile(env(agents), { text: 'hi', personId: 'pap', consent: false, lookup: db(rows) }, f)
    expect(a).toMatchObject({ ok: true, persona: 'mom', personId: 'mum' })
    expect(b).toMatchObject({ ok: true, persona: 'dad', personId: 'pap' })
    if (a.ok && b.ok) {
      expect(await a.audio.text()).toBe(`AUDIO:${MOM}`)
      expect(await b.audio.text()).toBe(`AUDIO:${DAD}`)
    }
    expect(seen.filter((s) => s.kind === 'agent').map((s) => s.id)).toEqual([MUM_AGENT, PAP_AGENT])
    expect(seen.filter((s) => s.kind === 'tts').map((s) => s.id)).toEqual([MOM, DAD])
  })
  it('a caller who cannot read a profile gets nothing, and no TTS request is made', async () => {
    const { f, seen } = fakeEleven()
    expect(await synthesizeForProfile(env(agents), { text: 'x', personId: 'pap', consent: true, lookup: db({ mum: rows.mum }) }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'forbidden' } })
    expect(await synthesizeForProfile(env(agents), { text: 'x', personId: 'mum', consent: true, lookup: db({ pap: rows.pap }) }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'forbidden' } })
    expect(seen.filter((s) => s.kind === 'tts' || s.kind === 'agent')).toEqual([])
  })
  it('missing Mummy agent never falls back to Papa’s voice', async () => {
    const { f, seen } = fakeEleven()
    const noMum = await synthesizeForProfile(env({ ...agents, MUMMY_ELEVENLABS_AGENT_ID: '' }), { text: 'x', personId: 'mum', consent: true, lookup: db(rows) }, f)
    expect(noMum).toMatchObject({ ok: false, body: { code: 'agent_not_configured', persona: 'mom' } })
    expect(seen.filter((s) => s.kind === 'tts')).toEqual([])
    const pap = await synthesizeForProfile(env({ ...agents, MUMMY_ELEVENLABS_AGENT_ID: '' }), { text: 'x', personId: 'pap', consent: false, lookup: db(rows) }, f)
    expect(pap).toMatchObject({ ok: true, persona: 'dad' })
  })
})

describe('separate Mummy and Papa agents', () => {
  const e2 = { ELEVENLABS_API_KEY: 'shared-key', MUMMY_ELEVENLABS_AGENT_ID: MUM_AGENT, PAPA_ELEVENLABS_AGENT_ID: PAP_AGENT }
  const calls: Array<{ agent: string | null; key: string | null }> = []
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url); calls.push({ agent: u.searchParams.get('agent_id'), key: (init.headers as Record<string, string>)['xi-api-key'] })
    return new Response(JSON.stringify({ signed_url: `wss://example/${u.searchParams.get('agent_id')}` }), { status: 200 })
  }) as unknown as typeof fetch
  const db = (rows: Record<string, ProfileRow>) => async (id: string) => rows[id] ?? null
  const rows = { mum: { id: 'mum', relationship: 'mother', active: true }, pap: { id: 'pap', relationship: 'father', active: true }, me: { id: 'me', relationship: 'self', active: true } }

  it('1-2. Mummy’s profile starts Mummy’s agent and Papa’s starts Papa’s, with the one shared key', async () => {
    calls.length = 0
    const a = await startProfileSession(env(e2), { personId: 'mum', consent: true, lookup: db(rows) }, f)
    const b = await startProfileSession(env(e2), { personId: 'pap', consent: true, lookup: db(rows) }, f)
    expect(a).toMatchObject({ ok: true, agent: 'mummy', personId: 'mum', signedUrl: `wss://example/${MUM_AGENT}` })
    expect(b).toMatchObject({ ok: true, agent: 'papa', personId: 'pap', signedUrl: `wss://example/${PAP_AGENT}` })
    expect(calls).toEqual([{ agent: MUM_AGENT, key: 'shared-key' }, { agent: PAP_AGENT, key: 'shared-key' }])
  })
  it('7. switching back and forth always picks the agent of the profile being used', async () => {
    calls.length = 0
    for (const id of ['mum', 'pap', 'pap', 'mum']) await startProfileSession(env(e2), { personId: id, consent: true, lookup: db(rows) }, f)
    expect(calls.map((c) => c.agent)).toEqual([MUM_AGENT, PAP_AGENT, PAP_AGENT, MUM_AGENT])
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
    expect(await startProfileSession(env({ ...e2, MUMMY_ELEVENLABS_AGENT_ID: '' }), { personId: 'pap', consent: true, lookup: db(rows) }, f)).toMatchObject({ ok: true, agent: 'papa' })
  })
  it('refuses to start when both profiles are pointed at the same agent', async () => {
    expect(await startProfileSession(env({ ...e2, PAPA_ELEVENLABS_AGENT_ID: MUM_AGENT }), { personId: 'pap', consent: true, lookup: db(rows) }, f)).toMatchObject({ ok: false, body: { code: 'agent_ids_identical' } })
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
  it('the cloned-voice consent guard still applies when the workspace flag is on', async () => {
    expect(await startProfileSession(env({ ...e2, ELEVENLABS_AGENT_USES_CLONED_VOICE: 'true' }), { personId: 'mum', consent: false, lookup: db(rows) }, f)).toMatchObject({ ok: false, status: 403, body: { code: 'consent_required' } })
    expect(await startProfileSession(env(e2), { personId: 'mum', consent: false, lookup: db(rows) }, f)).toMatchObject({ ok: true, agent: 'mummy' })
  })
})
