// Reminder TTS via ElevenLabs. The authorised family profile is loaded under RLS; Mummy/Papa speech uses the Voice ID
// configured on that profile’s conversational agent (GET /v1/convai/agents/{id}). Agent IDs, Voice IDs and the API key
// never leave the server. There is no cross-parent fallback. Interactive talk still uses elevenlabs-session.
import { corsHeaders, fail, json, requireUser } from '../_shared/http.ts'
import { synthesize, synthesizeForProfile } from '../_shared/elevenlabs.ts'

const UUID_OR_LOCAL = /^[A-Za-z0-9_-]{1,64}$/

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who
  let text = '', persona: unknown, personId: unknown
  try { const b = await req.json(); text = String(b.text ?? '').trim(); persona = b.persona; personId = b.personId } catch { return fail(400, 'Expected JSON {text, persona}') }
  if (!text) return fail(400, 'Missing text')
  if (text.length > 600) return fail(413, 'Text too long')
  const { data: p } = await db.from('profiles').select('voice_cloning_consent').eq('id', user.id).maybeSingle()
  const env = (k: string) => Deno.env.get(k)
  const consent = !!p?.voice_cloning_consent
  const r = typeof personId === 'string' && UUID_OR_LOCAL.test(personId)
    ? await synthesizeForProfile(env, {
      text, personId, consent,
      lookup: async (id) => (await db.from('care_recipients').select('id, relationship, active').eq('id', id).maybeSingle()).data,
    })
    : await synthesize(env, { text, persona, consent })
  if (!r.ok) return json(r.body, r.status)
  return new Response(r.audio.body, { headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg', 'x-ai-voice': 'true', 'x-voice-persona': r.persona, 'Access-Control-Expose-Headers': 'x-voice-persona, x-ai-voice', 'Cache-Control': 'no-store' } })
})
