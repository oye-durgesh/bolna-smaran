// ElevenLabs server-side calls, shared by the Edge Functions and the local dev API. The API key is passed in, never imported.
// Documented endpoints used:
//   POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_64   (header xi-api-key)  → audio
//   GET  /v1/convai/agents/{agent_id}                                (header xi-api-key)  → agent, including conversation_config.tts.voice_id
//   GET  /v1/convai/conversation/get-signed-url?agent_id=…          (header xi-api-key)  → { signed_url }
//   GET  /v1/voices/{voice_id}                                       (header xi-api-key)  → voice metadata (clone vs licensed)
import { isClonedVoiceCategory, isVoiceId, personaLabel, resolveVoice, voiceFailureFromStatus } from './voices.ts'
import type { Persona } from './voices.ts'

export interface Env { (k: string): string | undefined }
export type Fail = { ok: false; status: number; body: { error: string; code: string; persona?: Persona | null } }

const base = (env: Env) => env('ELEVENLABS_BASE_URL') ?? 'https://api.elevenlabs.io' // override is for tests against a fake server only
const failStatus = (code: string) => code === 'consent_required' ? 403 : code === 'bad_persona' || code === 'bad_request' ? 400 : code === 'forbidden' ? 403 : code === 'rate_limit' ? 429 : 503

/** Which dedicated agent a family profile uses. Only Mummy and Papa have one; nothing else may borrow either. */
export type AgentWho = 'mummy' | 'papa'
export const AGENT_ENV: Record<AgentWho, string> = { mummy: 'MUMMY_ELEVENLABS_AGENT_ID', papa: 'PAPA_ELEVENLABS_AGENT_ID' }
export const agentForRelationship = (relationship: unknown): AgentWho | null => relationship === 'mother' ? 'mummy' : relationship === 'father' ? 'papa' : null
export const personaForAgent = (who: AgentWho): Persona => (who === 'mummy' ? 'mom' : 'dad')
export const agentForPersona = (persona: unknown): AgentWho | null => persona === 'mom' ? 'mummy' : persona === 'dad' ? 'papa' : null
const AGENT_ID = /^[A-Za-z0-9_-]{8,128}$/

export function configuredAgent(env: Env, who: AgentWho): Fail | { ok: true; who: AgentWho; agentId: string; idVar: string } {
  const idVar = AGENT_ENV[who]
  const agent = (env(idVar) ?? '').trim()
  if (!agent) return { ok: false, status: 503, body: { error: `${who === 'mummy' ? "Mummy's" : "Papa's"} Sathi agent is not configured on the server (${idVar} is missing).`, code: 'agent_not_configured', persona: personaForAgent(who) } }
  if (!AGENT_ID.test(agent)) return { ok: false, status: 503, body: { error: `${idVar} does not look like an ElevenLabs agent ID.`, code: 'agent_invalid', persona: personaForAgent(who) } }
  const otherWho: AgentWho = who === 'mummy' ? 'papa' : 'mummy'
  const other = (env(AGENT_ENV[otherWho]) ?? '').trim()
  if (other && other === agent) return { ok: false, status: 503, body: { error: 'MUMMY_ELEVENLABS_AGENT_ID and PAPA_ELEVENLABS_AGENT_ID are the same. Each profile needs its own agent.', code: 'agent_ids_identical', persona: personaForAgent(who) } }
  return { ok: true, who, agentId: agent, idVar }
}

type AgentVoiceOk = { ok: true; who: AgentWho; persona: Persona; voiceId: string }

/** GET the agent and return only its configured Voice ID. Never uses the other parent. Voice ID is not included in Fail bodies. */
export async function voiceIdForAgent(env: Env, who: AgentWho, f: typeof fetch = fetch): Promise<Fail | AgentVoiceOk> {
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice playback is not configured on the server.', code: 'missing_credentials' } }
  const cfg = configuredAgent(env, who)
  if (!cfg.ok) return cfg
  const persona = personaForAgent(who)
  let r: Response
  try {
    r = await f(`${base(env)}/v1/convai/agents/${encodeURIComponent(cfg.agentId)}`, { headers: { 'xi-api-key': key } })
  } catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable', persona } } }
  if (r.status === 404 || r.status === 422) return { ok: false, status: 502, body: { error: `${cfg.idVar} was not found in your ElevenLabs workspace.`, code: 'agent_invalid', persona } }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 502, body: { error: 'ElevenLabs rejected ELEVENLABS_API_KEY (invalid, or without access to this agent).', code: 'auth', persona } }
  if (r.status === 429) return { ok: false, status: 429, body: { error: 'The voice service is busy. Please try again shortly.', code: 'rate_limit', persona } }
  if (!r.ok) return { ok: false, status: 502, body: { error: `Voice service unavailable (${r.status}).`, code: 'unavailable', persona } }
  const j = await r.json().catch(() => null) as { conversation_config?: { tts?: { voice_id?: unknown } } } | null
  const voiceId = typeof j?.conversation_config?.tts?.voice_id === 'string' ? j.conversation_config.tts.voice_id.trim() : ''
  if (!voiceId) return { ok: false, status: 503, body: { error: `${personaLabel(persona)} ElevenLabs agent has no Voice ID configured.`, code: 'voice_not_configured', persona } }
  if (!isVoiceId(voiceId)) return { ok: false, status: 503, body: { error: `${personaLabel(persona)} agent Voice setting is not a valid ElevenLabs voice ID.`, code: 'voice_invalid', persona } }
  return { ok: true, who, persona, voiceId }
}

/** Consent is required only for actual clones (or when the workspace flag says the agents use cloned voices). Licensed library voices are allowed. */
export async function clonedVoiceRequiresConsent(env: Env, voiceId: string, f: typeof fetch = fetch): Promise<Fail | { ok: true; cloned: boolean }> {
  if (env('ELEVENLABS_AGENT_USES_CLONED_VOICE') === 'true') return { ok: true, cloned: true }
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice playback is not configured on the server.', code: 'missing_credentials' } }
  let r: Response
  try {
    r = await f(`${base(env)}/v1/voices/${encodeURIComponent(voiceId)}`, { headers: { 'xi-api-key': key } })
  } catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable' } } }
  if (r.status === 429) return { ok: false, status: 429, body: { error: 'The voice service is busy. Please try again shortly.', code: 'rate_limit' } }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 502, body: { error: 'ElevenLabs rejected ELEVENLABS_API_KEY (invalid, or without access to this voice).', code: 'auth' } }
  if (r.status === 404 || r.status === 422) return { ok: false, status: 502, body: { error: 'The agent’s configured voice was not found in ElevenLabs.', code: 'voice_invalid' } }
  if (!r.ok) return { ok: false, status: 502, body: { error: `Voice service unavailable (${r.status}).`, code: 'unavailable' } }
  const j = await r.json().catch(() => null) as { category?: unknown } | null
  return { ok: true, cloned: isClonedVoiceCategory(j?.category) }
}

async function ttsWithVoice(env: Env, input: { text: string; persona: Persona; voiceId: string; consent: boolean }, f: typeof fetch):
  Promise<Fail | { ok: true; persona: Persona; audio: Response }> {
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice playback is not configured on the server.', code: 'missing_credentials' } }
  const clone = await clonedVoiceRequiresConsent(env, input.voiceId, f)
  if (!clone.ok) return { ...clone, body: { ...clone.body, persona: input.persona } }
  if (clone.cloned && !input.consent) {
    return { ok: false, status: 403, body: { error: 'Voice cloning consent has not been given, so a cloned voice cannot be used.', code: 'consent_required', persona: input.persona } }
  }
  let r: Response
  try {
    r = await f(`${base(env)}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_64`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.text, model_id: env('ELEVENLABS_MODEL_ID') ?? 'eleven_multilingual_v2' }),
    })
  } catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable', persona: input.persona } } }
  if (!r.ok || !r.body) {
    const fl = voiceFailureFromStatus(r.status)
    return { ok: false, status: fl.http, body: { error: fl.code === 'voice_invalid' ? `The configured ${input.persona} voice ID was rejected by ElevenLabs.` : `Voice service unavailable (${r.status}).`, code: fl.code, persona: input.persona } }
  }
  return { ok: true, persona: input.persona, audio: r }
}

export async function synthesize(env: Env, input: { text: string; persona: unknown; consent: boolean }, f: typeof fetch = fetch):
  Promise<Fail | { ok: true; persona: Persona; audio: Response }> {
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice playback is not configured on the server.', code: 'missing_credentials' } }
  const who = agentForPersona(input.persona === undefined || input.persona === null || input.persona === '' ? 'default' : input.persona)
  if (who) {
    const v = await voiceIdForAgent(env, who, f)
    if (!v.ok) return v
    return ttsWithVoice(env, { text: input.text, persona: v.persona, voiceId: v.voiceId, consent: input.consent }, f)
  }
  const resolved = resolveVoice(input.persona, env, input.consent)
  if (!resolved.ok) return { ok: false, status: failStatus(resolved.code), body: { error: resolved.message, code: resolved.code, persona: resolved.persona } }
  return ttsWithVoice(env, { text: input.text, persona: resolved.persona, voiceId: resolved.voiceId, consent: input.consent }, f)
}

/** Authorised reminder TTS: the profile must be readable by the caller; the agent (and its voice) come from that row, not the browser. */
export async function synthesizeForProfile(env: Env, input: {
  text: string; personId: string; consent: boolean; lookup: (personId: string) => Promise<ProfileRow | null>
}, f: typeof fetch = fetch): Promise<Fail | { ok: true; persona: Persona; audio: Response; personId: string }> {
  const row = await input.lookup(input.personId)
  if (!row || !row.active) return { ok: false, status: 403, body: { error: 'You do not have access to this family profile.', code: 'forbidden' } }
  const who = agentForRelationship(row.relationship)
  if (!who) {
    const r = await synthesize(env, { text: input.text, persona: 'default', consent: input.consent }, f)
    return r.ok ? { ...r, personId: row.id } : r
  }
  const v = await voiceIdForAgent(env, who, f)
  if (!v.ok) return v
  const r = await ttsWithVoice(env, { text: input.text, persona: v.persona, voiceId: v.voiceId, consent: input.consent }, f)
  return r.ok ? { ...r, personId: row.id } : r
}

export async function agentSession(env: Env, input: { relationship: unknown; consent: boolean }, f: typeof fetch = fetch):
  Promise<Fail | { ok: true; agent: AgentWho; signedUrl: string }> {
  const who = agentForRelationship(input.relationship)
  if (!who) return { ok: false, status: 422, body: { error: 'Only Mummy and Papa have a dedicated Sathi agent. This profile has none.', code: 'no_agent_for_profile' } }
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return { ok: false, status: 503, body: { error: 'Voice conversations are not configured on the server (ELEVENLABS_API_KEY is missing).', code: 'missing_credentials' } }
  const cfg = configuredAgent(env, who)
  if (!cfg.ok) return cfg
  if (env('ELEVENLABS_AGENT_USES_CLONED_VOICE') === 'true' && !input.consent)
    return { ok: false, status: 403, body: { error: 'Voice cloning consent has not been given.', code: 'consent_required' } }
  let r: Response
  try { r = await f(`${base(env)}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(cfg.agentId)}`, { headers: { 'xi-api-key': key } }) }
  catch { return { ok: false, status: 502, body: { error: 'The voice service could not be reached.', code: 'unavailable' } } }
  if (r.status === 404 || r.status === 422) return { ok: false, status: 502, body: { error: `${cfg.idVar} was not found in your ElevenLabs workspace.`, code: 'agent_invalid' } }
  if (r.status === 401 || r.status === 403) return { ok: false, status: 502, body: { error: 'ElevenLabs rejected ELEVENLABS_API_KEY (invalid, or without access to this agent).', code: 'auth' } }
  if (r.status === 429) return { ok: false, status: 429, body: { error: 'The voice service is busy. Please try again shortly.', code: 'rate_limit' } }
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
