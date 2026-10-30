// Text-to-speech for Sathi's replies via ElevenLabs. The caller picks a persona (default | mom | dad); each maps to its OWN
// configured voice ID (_shared/voices.ts). There is no cross-persona fallback. Returns audio/mpeg with x-voice-persona.
import { corsHeaders, fail, json, requireUser } from '../_shared/http.ts'
import { synthesize } from '../_shared/elevenlabs.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who
  let text = '', persona: unknown
  try { const b = await req.json(); text = String(b.text ?? '').trim(); persona = b.persona } catch { return fail(400, 'Expected JSON {text, persona}') }
  if (!text) return fail(400, 'Missing text')
  if (text.length > 600) return fail(413, 'Text too long')
  const { data: p } = await db.from('profiles').select('voice_cloning_consent').eq('id', user.id).maybeSingle()
  const r = await synthesize((k) => Deno.env.get(k), { text, persona, consent: !!p?.voice_cloning_consent })
  if (!r.ok) return json(r.body, r.status)
  return new Response(r.audio.body, { headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg', 'x-ai-voice': 'true', 'x-voice-persona': r.persona, 'Access-Control-Expose-Headers': 'x-voice-persona, x-ai-voice', 'Cache-Control': 'no-store' } })
})
