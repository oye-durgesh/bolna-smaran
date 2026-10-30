/** Mom/Dad voice mapping and the ElevenLabs server calls, against a FAKE ElevenLabs (records which voice ID each request used). */
import { describe, expect, it } from 'vitest'
import { resolveVoice, VOICE_ENV, voiceFailureFromStatus } from '../functions/_shared/voices.ts'
import { agentSession, synthesize } from '../functions/_shared/elevenlabs.ts'

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

describe('agent session', () => {
  it('returns the persona’s own voice ID for the per-conversation override, for each new session', async () => {
    const { f } = fakeEleven()
    const a = await agentSession(env(full), { persona: 'mom', consent: true }, f)
    const b = await agentSession(env(full), { persona: 'dad', consent: true }, f)
    expect(a).toMatchObject({ ok: true, persona: 'mom', voiceId: MOM, signedUrl: 'wss://example/agent_1' })
    expect(b).toMatchObject({ ok: true, persona: 'dad', voiceId: DAD })
  })
  it('refuses when the agent, voice or consent is missing; never starts with a different voice', async () => {
    const { f } = fakeEleven()
    expect(await agentSession(env({ ...full, ELEVENLABS_AGENT_ID: '' }), { persona: 'mom', consent: true }, f)).toMatchObject({ ok: false, body: { code: 'missing_credentials' } })
    expect(await agentSession(env({ ...full, ELEVENLABS_DAD_VOICE_ID: '' }), { persona: 'dad', consent: true }, f)).toMatchObject({ ok: false, body: { code: 'voice_not_configured' } })
    expect(await agentSession(env(full), { persona: 'mom', consent: false }, f)).toMatchObject({ ok: false, status: 403 })
  })
  it('reports an unknown agent and network failure', async () => {
    const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    expect(await agentSession(env(full), { persona: 'mom', consent: true }, notFound)).toMatchObject({ ok: false, body: { code: 'agent_invalid' } })
    const down = (async () => { throw new Error('x') }) as unknown as typeof fetch
    expect(await agentSession(env(full), { persona: 'mom', consent: true }, down)).toMatchObject({ ok: false, body: { code: 'unavailable' } })
  })
})
