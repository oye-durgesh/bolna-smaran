// Issues a short-lived signed URL for the ElevenLabs agent that belongs to ONE family profile (Mummy or Papa).
// The profile is looked up in the database as the signed-in caller (row-level security), and the agent is chosen from that row's
// relationship, never from a name or agent sent by the browser. One shared ELEVENLABS_API_KEY stays on the server; only the
// temporary signed URL is returned. Each agent keeps the voice and system prompt configured in the ElevenLabs dashboard.
import { corsHeaders, json, requireUser, audit } from '../_shared/http.ts'
import { startProfileSession } from '../_shared/elevenlabs.ts'

const UUID_OR_LOCAL = /^[A-Za-z0-9_-]{1,64}$/

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who
  let personId: unknown
  try { personId = (await req.json()).personId } catch { /* handled below */ }
  if (typeof personId !== 'string' || !UUID_OR_LOCAL.test(personId)) return json({ error: 'personId is required.', code: 'bad_request' }, 400)
  // Visible only if the caller owns this profile or has been given access to its owner (RLS: care_select).
  const { data: prof } = await db.from('profiles').select('voice_cloning_consent').eq('id', user.id).maybeSingle()
  const r = await startProfileSession((k) => Deno.env.get(k), {
    personId, consent: !!prof?.voice_cloning_consent,
    lookup: async (id) => (await db.from('care_recipients').select('id, relationship, active').eq('id', id).maybeSingle()).data,
  })
  if (!r.ok) return json(r.body, r.status)
  await audit(db, user.id, user.id, 'voice_session_issued', `agent=${r.agent}`)
  return json({ signedUrl: r.signedUrl, agent: r.agent, personId: r.personId, disclosure: 'Sathi is an AI companion, not a person.' })
})
