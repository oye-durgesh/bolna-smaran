// ElevenLabs server-side calls, shared by the Edge Functions and the local dev API. The API key is passed in, never imported.
// Documented endpoints used:
//   POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_64   (header xi-api-key)  → audio
//   GET  /v1/convai/conversation/get-signed-url?agent_id=…          (header xi-api-key)  → { signed_url }  (current ElevenLabs Conversational AI docs)
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

/** Which dedicated agent a family profile uses. Only Mummy and Papa have one; nothing else may borrow either. */
export type AgentWho = 'mummy' | 'papa'
export const AGENT_ENV: Record<AgentWho, string> = { mummy: 'MUMMY_ELEVENLABS_AGENT_ID', papa: 'PAPA_ELEVENLABS_AGENT_ID' }
export const agentForRelationship = (relationship: unknown): AgentWho | null => relationship === 'mother' ? 'mummy' : relationship === 'father' ? 'papa' : null
const AGENT_ID = /^[A-Za-z0-9_-]{8,128}$/

/**
 * Starts a conversation for ONE profile. `relationship` must come from the database row the caller was authorised to read,
 * never from the browser. One shared ELEVENLABS_API_KEY (both agents live in the same workspace); a separate agent ID per
 * profile. A missing or invalid setting for the selected profile is an error, never a fallback to the other agent.
 */
export async function agentSession(env: Env, input: { relationship: unknown; consent: boolean }, f: typeof fetch = fetch):
  Promise<Fail | { ok: true; agent: AgentWho; signedUrl: string }> {
  const who = agentForRelationship(input.relationship)
  if (!who) return { ok: false, status: 422, body: { error: 'Only Mummy and Papa have a dedicated Sathi agent. This profile has none.', code: 'no_agent_for_profile' } }
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice conversations are not configured on the server (ELEVENLABS_API_KEY is missing).', code: 'missing_credentials' } }
  const idVar = AGENT_ENV[who]
  const agent = (env(idVar) ?? '').trim()
  if (!agent) return { ok: false, status: 503, body: { error: `${who === 'mummy' ? "Mummy's" : "Papa's"} Sathi agent is not configured on the server (${idVar} is missing).`, code: 'agent_not_configured' } }
  if (!AGENT_ID.test(agent)) return { ok: false, status: 503, body: { error: `${idVar} does not look like an ElevenLabs agent ID.`, code: 'agent_invalid' } }
  const other = (env(AGENT_ENV[who === 'mummy' ? 'papa' : 'mummy']) ?? '').trim()
  if (other && other === agent) return { ok: false, status: 503, body: { error: 'MUMMY_ELEVENLABS_AGENT_ID and PAPA_ELEVENLABS_AGENT_ID are the same. Each profile needs its own agent.', code: 'agent_ids_identical' } }
  if (env('ELEVENLABS_AGENT_USES_CLONED_VOICE') === 'true' && !input.consent)
    return { ok: false, status: 403, body: { error: 'Voice cloning consent has not been given.', code: 'consent_required' } }
  let r: Response
  try { r = await f(`${base(env)}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`, { headers: { 'xi-api-key': key } }) }
  catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable' } } }
  if (r.status === 404 || r.status === 422) return { ok: false, status: 502, body: { error: `${idVar} was not found in your ElevenLabs workspace.`, code: 'agent_invalid' } }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 502, body: { error: 'ElevenLabs rejected ELEVENLABS_API_KEY (invalid, or without access to this agent).', code: 'auth' } }
  if (!r.ok) return { ok: false, status: 502, body: { error: `Voice service unavailable (${r.status}).`, code: 'unavailable' } }
  const j = await r.json().catch(() => null) as { signed_url?: string } | null
  if (!j?.signed_url) return { ok: false, status: 502, body: { error: 'The voice service returned no session URL.', code: 'unavailable' } }
  return { ok: true, agent: who, signedUrl: j.signed_url }
}

/** A profile row as the caller is allowed to read it (row-level security decides what `lookup` can see). */
export interface ProfileRow { id: string; relationship: string; active: boolean }

/** Authorised session start: the profile must be readable by the caller, and the agent comes from that row, not from the request. */
export async function startProfileSession(env: Env, input: { personId: string; consent: boolean; lookup: (personId: string) => Promise<ProfileRow | null> }, f: typeof fetch = fetch):
  Promise<Fail | { ok: true; agent: AgentWho; signedUrl: string; personId: string }> {
  const row = await input.lookup(input.personId)
  if (!row || !row.active) return { ok: false, status: 403, body: { error: 'You do not have access to this family profile.', code: 'forbidden' } }
  const r = await agentSession(env, { relationship: row.relationship, consent: input.consent }, f)
  return r.ok ? { ...r, personId: row.id } : r
}

/** Looks the voice up in the ElevenLabs account (does it exist, what is it called). For the smoke test. */
export async function describeVoice(key: string, voiceId: string, f: typeof fetch = fetch): Promise<{ ok: true; name: string; category?: string } | { ok: false; status: number }> {
  const r = await f(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { 'xi-api-key': key } })
  if (!r.ok) return { ok: false, status: r.status }
  const j = await r.json() as { name?: string; category?: string }
  return { ok: true, name: j.name ?? '(unnamed)', category: j.category }
}
