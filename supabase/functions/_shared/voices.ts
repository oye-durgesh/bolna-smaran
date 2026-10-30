// Sathi voice selection. Pure (no Deno/Node APIs) so it is shared by Edge Functions, the local dev server and the app tests.
// Mom and Dad are SEPARATE configured voice IDs. A persona never falls back to another persona's voice:
// if its ID is missing the caller gets `voice_not_configured` and must use a non-person fallback (the browser voice) or show text.
export type Persona = 'default' | 'mom' | 'dad'
export const PERSONAS: Persona[] = ['default', 'mom', 'dad']
export const isPersona = (v: unknown): v is Persona => typeof v === 'string' && (PERSONAS as string[]).includes(v)

/** The env variable that holds each persona's voice ID. This table is the only mapping between a selection and a voice. */
export const VOICE_ENV: Record<Persona, string> = {
  default: 'ELEVENLABS_VOICE_ID',
  mom: 'ELEVENLABS_MOM_VOICE_ID',
  dad: 'ELEVENLABS_DAD_VOICE_ID',
}
/** Voices that imitate a real person need the account holder's recorded consent (and you must hold the right to use the voice). */
export const NEEDS_CONSENT: Record<Persona, boolean> = { default: false, mom: true, dad: true }

export type VoiceFailure = 'bad_persona' | 'voice_not_configured' | 'consent_required' | 'voice_invalid'
export type VoiceResolution = { ok: true; persona: Persona; voiceId: string } | { ok: false; persona: Persona | null; code: VoiceFailure; message: string }

const ID_RE = /^[A-Za-z0-9]{10,40}$/
export const personaLabel = (p: Persona) => (p === 'mom' ? "Mom's" : p === 'dad' ? "Dad's" : 'the default')

export function resolveVoice(personaIn: unknown, env: (k: string) => string | undefined, consent: boolean): VoiceResolution {
  const persona = personaIn === undefined || personaIn === null || personaIn === '' ? 'default' : personaIn
  if (!isPersona(persona)) return { ok: false, persona: null, code: 'bad_persona', message: 'Unknown voice selection.' }
  const id = (env(VOICE_ENV[persona]) ?? '').trim()
  if (!id) return { ok: false, persona, code: 'voice_not_configured', message: `${personaLabel(persona)} voice is not set up on the server (${VOICE_ENV[persona]} is missing).` }
  if (!ID_RE.test(id)) return { ok: false, persona, code: 'voice_invalid', message: `${VOICE_ENV[persona]} does not look like a valid ElevenLabs voice ID.` }
  if (NEEDS_CONSENT[persona] && !consent) return { ok: false, persona, code: 'consent_required', message: `Voice consent has not been given, so ${personaLabel(persona)} voice cannot be used.` }
  return { ok: true, persona, voiceId: id }
}

/** Map an ElevenLabs HTTP failure to our codes. 404/422 on a voice means the configured ID is wrong. */
export function voiceFailureFromStatus(status: number): { code: VoiceFailure | 'unavailable' | 'auth' | 'rate_limit'; http: number } {
  if (status === 404 || status === 422 || status === 400) return { code: 'voice_invalid', http: 502 }
  if (status === 401 || status === 403) return { code: 'auth', http: 502 }
  if (status === 429) return { code: 'rate_limit', http: 429 }
  return { code: 'unavailable', http: 502 }
}
