// Issues a short-lived signed URL for an ElevenLabs Agents conversation, plus the voice the CLIENT must request for it.
// Per the ElevenLabs docs the agent's own voice is NOT changed by the TTS endpoint: it is changed per conversation with the
// `overrides.tts.voiceId` option, and only if "Voice ID" is enabled in the agent's Security settings (otherwise ElevenLabs
// rejects the session and the app shows that error instead of letting the wrong voice speak).
// The API key never leaves the server. Mom/Dad voices need the user's recorded consent. Sathi is always disclosed as an AI.
import { corsHeaders, json, requireUser, audit } from '../_shared/http.ts'
import { agentSession } from '../_shared/elevenlabs.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who
  let persona: unknown
  try { persona = (await req.json()).persona } catch { /* no body = default */ }
  const { data } = await db.from('profiles').select('voice_cloning_consent').eq('id', user.id).maybeSingle()
  const r = await agentSession((k) => Deno.env.get(k), { persona, consent: !!data?.voice_cloning_consent })
  if (!r.ok) return json(r.body, r.status)
  await audit(db, user.id, user.id, 'voice_session_issued', `persona=${r.persona}`)
  return json({ signedUrl: r.signedUrl, persona: r.persona, voiceId: r.voiceId, disclosure: 'Sathi is an AI companion, not a person.' })
})
