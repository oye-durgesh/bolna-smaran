// ElevenLabs server-side calls, shared by the Edge Functions and the local dev API. The API key is passed in, never imported.
// Documented endpoints used:
//   POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_64   (header xi-api-key)  → audio
//   GET  /v1/convai/conversation/get-signed-url?agent_id=…          (header xi-api-key)  → { signed_url }
//   GET  /v1/voices/{voice_id}                                       (header xi-api-key)  → voice metadata (smoke test)
import { resolveVoice, voiceFailureFromStatus } from './voices.ts'
import type { Persona } from './voices.ts'

export interface Env { (k: string): string | undefined }
export type Fail = { ok: false; status: number; body: { error: string; code: string; persona?: Persona | null } }

const base = (env: Env) => env('ELEVENLABS_BASE_URL') ?? 'https://api.elevenlabs.io' // override is for tests against a fake server only

export async function synthesize(env: Env, input: { text: string; persona: unknown; consent: boolean }, f: typeof fetch = fetch):
  Promise<Fail | { ok: true; persona: Persona; audio: Response }> {
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice playback is not configured on the server.', code: 'missing_credentials' } }
  const v = resolveVoice(input.persona, env, input.consent)
  if (!v.ok) return { ok: false, status: v.code === 'consent_required' ? 403 : v.code === 'bad_persona' ? 400 : 503, body: { error: v.message, code: v.code, persona: v.persona } }
  let r: Response
  try {
    r = await f(`${base(env)}/v1/text-to-speech/${encodeURIComponent(v.voiceId)}?output_format=mp3_44100_64`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.text, model_id: env('ELEVENLABS_MODEL_ID') ?? 'eleven_multilingual_v2' }),
    })
  } catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable', persona: v.persona } } }
  if (!r.ok || !r.body) {
    const fl = voiceFailureFromStatus(r.status)
    return { ok: false, status: fl.http, body: { error: fl.code === 'voice_invalid' ? `The configured ${v.persona} voice ID was rejected by ElevenLabs.` : `Voice service unavailable (${r.status}).`, code: fl.code, persona: v.persona } }
  }
  return { ok: true, persona: v.persona, audio: r }
}

export async function agentSession(env: Env, input: { persona: unknown; consent: boolean }, f: typeof fetch = fetch):
  Promise<Fail | { ok: true; persona: Persona; voiceId: string; signedUrl: string }> {
  const key = env('ELEVENLABS_API_KEY'), agent = env('ELEVENLABS_AGENT_ID')
  if (!key || !agent) return { ok: false, status: 503, body: { error: 'Voice conversations are not configured on the server (ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID).', code: 'missing_credentials' } }
  const v = resolveVoice(input.persona, env, input.consent)
  if (!v.ok) return { ok: false, status: v.code === 'consent_required' ? 403 : v.code === 'bad_persona' ? 400 : 503, body: { error: v.message, code: v.code, persona: v.persona } }
  if (v.persona === 'default' && env('ELEVENLABS_AGENT_USES_CLONED_VOICE') === 'true' && !input.consent)
    return { ok: false, status: 403, body: { error: 'Voice cloning consent has not been given.', code: 'consent_required', persona: v.persona } }
  let r: Response
  try { r = await f(`${base(env)}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`, { headers: { 'xi-api-key': key } }) }
  catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable' } } }
  if (r.status === 404 || r.status === 422) return { ok: false, status: 502, body: { error: 'ELEVENLABS_AGENT_ID was not found in your ElevenLabs account.', code: 'agent_invalid' } }
  if (!r.ok) return { ok: false, status: 502, body: { error: `Voice service unavailable (${r.status}).`, code: r.status === 401 || r.status === 403 ? 'auth' : 'unavailable' } }
  const j = await r.json().catch(() => null) as { signed_url?: string } | null
  if (!j?.signed_url) return { ok: false, status: 502, body: { error: 'The voice service returned no session URL.', code: 'unavailable' } }
  return { ok: true, persona: v.persona, voiceId: v.voiceId, signedUrl: j.signed_url }
}

/** Looks the voice up in the ElevenLabs account (does it exist, what is it called). For the smoke test. */
export async function describeVoice(key: string, voiceId: string, f: typeof fetch = fetch): Promise<{ ok: true; name: string; category?: string } | { ok: false; status: number }> {
  const r = await f(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { 'xi-api-key': key } })
  if (!r.ok) return { ok: false, status: r.status }
  const j = await r.json() as { name?: string; category?: string }
  return { ok: true, name: j.name ?? '(unnamed)', category: j.category }
}
