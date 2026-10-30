// Runs every minute from pg_cron. Idempotent and safe to run concurrently:
//   1. materialise recurring reminders   2. atomically claim due reminders (FOR UPDATE SKIP LOCKED)
//   3. Web Push to the owner's devices   4. record every attempt   5. retry with backoff / expire stale ones.
// A delivered notification is NEVER treated as "medicine taken".
import webpush from 'npm:web-push@3'
import { buildPayload, shouldPush } from '../_shared/dispatch-payload.ts'
import { corsHeaders, fail, json, serviceClient, timingSafeEqual } from '../_shared/http.ts'

interface Claimed { id: string; owner_id: string; person_id: string; kind: string; title: string; scheduled_for: string; dispatched_for: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || !timingSafeEqual(req.headers.get('x-cron-secret') ?? '', secret)) return fail(401, 'Unauthorized')

  const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY'), subject = Deno.env.get('VAPID_SUBJECT')
  if (!pub || !priv || !subject) return fail(500, 'VAPID keys are not configured (see supabase/README.md)')
  webpush.setVapidDetails(subject, pub, priv)

  const db = serviceClient()
  const stats = { materialized: 0, claimed: 0, delivered: 0, failed: 0, retried: 0, expired: 0, notifications_off: 0 }

  const m = await db.rpc('materialize_reminders', { p_horizon_days: 2 })
  if (!m.error) stats.materialized = m.data as number

  const claim = await db.rpc('claim_due_reminders', { p_batch: 100 })
  if (claim.error) return fail(500, `claim failed: ${claim.error.message}`)
  const due = (claim.data ?? []) as Claimed[]
  stats.claimed = due.length

  for (const r of due) {
    const { data: subs } = await db.from('device_tokens').select('id, subscription').eq('owner_id', r.owner_id)
    const { data: who } = await db.from('care_recipients').select('greeting_name, display_name, relationship, notifications_enabled').eq('id', r.person_id).maybeSingle()
    // The person's own setting wins: with notifications off for this profile nothing is pushed. The reminder stays due in the app, and the
    // attempt is recorded, so it is never silently lost and never reported as delivered.
    if (!shouldPush(who)) {
      await db.from('delivery_attempts').insert({ reminder_id: r.id, owner_id: r.owner_id, due_at: r.dispatched_for, channel: 'server-push', outcome: 'failed', detail: { reason: 'notifications_off_for_profile' } })
      stats.notifications_off++
      continue
    }
    const payload = JSON.stringify(buildPayload(r, who))
    let ok = 0
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(s.subscription, payload, { TTL: 3600, urgency: 'high' })
        ok++
        await db.from('delivery_attempts').insert({ reminder_id: r.id, owner_id: r.owner_id, due_at: r.dispatched_for, channel: 'server-push', outcome: 'delivered', detail: { device: s.id } })
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0
        await db.from('delivery_attempts').insert({ reminder_id: r.id, owner_id: r.owner_id, due_at: r.dispatched_for, channel: 'server-push', outcome: 'failed', detail: { device: s.id, status } })
        if (status === 404 || status === 410) await db.from('device_tokens').delete().eq('id', s.id) // subscription is gone
      }
    }
    if (ok > 0) stats.delivered++
    else {
      stats.failed++
      const why = (subs?.length ?? 0) === 0 ? 'no registered device' : 'all pushes failed'
      await db.rpc('release_for_retry', { p_id: r.id, p_error: why })
      stats.retried++
    }
  }

  const ex = await db.rpc('expire_stale_reminders', { p_minutes: 60 })
  if (!ex.error) stats.expired = ex.data as number
  return json(stats)
})
