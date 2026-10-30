// Authenticated reminder operations for the voice agent and the app. Identity comes from the verified JWT; every write goes through the
// caller's own Supabase client, so Row Level Security (owner_id = auth.uid()) and the person_id foreign key apply as a second line of defence.
// POST { action: 'create'|'list_today'|'snooze'|'reschedule'|'cancel'|'complete', ... }  →  { status, ... } (see _shared/reminder-tool.ts)
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, fail, json, requireUser } from '../_shared/http.ts'
import {
  cancelTool, completeTool, skipTool, createReminderTool, listTodayTool, rescheduleTool, snoozeTool, StoreError,
  type MedRow, type PersonRow, type ReminderRow, type ToolStore,
} from '../_shared/reminder-tool.ts'

function dbStore(db: SupabaseClient, uid: string): ToolStore {
  const must = <T>(r: { data: T | null; error: { code?: string; message: string } | null }): T | null => {
    if (r.error) throw new StoreError(r.error.code === '23505' ? 'conflict' : 'unavailable', r.error.message)
    return r.data
  }
  return {
    getPerson: async (id) => must<PersonRow>(await db.from('care_recipients').select('id, owner_id, active, time_zone, display_name, greeting_name, language').eq('id', id).maybeSingle()),
    getMedication: async (id) => must<MedRow>(await db.from('medications').select('id, owner_id, person_id, status, name').eq('id', id).maybeSingle()),
    findReminderByKey: async (o, k) => must<ReminderRow>(await db.from('reminders').select('*').eq('owner_id', o).eq('idempotency_key', k).maybeSingle()),
    getReminder: async (id) => must<ReminderRow>(await db.from('reminders').select('*').eq('id', id).maybeSingle()),
    insertReminder: async (r) => must<ReminderRow>(await db.from('reminders').insert(r).select('*').single())!,
    insertSeries: async (s) => { must(await db.from('reminder_series').upsert(s, { onConflict: 'id', ignoreDuplicates: true })) },
    updateReminder: async (id, patch) => must<ReminderRow>(await db.from('reminders').update(patch).eq('id', id).select('*').single())!,
    listReminders: async (pid, from, to) => must<ReminderRow[]>(await db.from('reminders').select('*').eq('person_id', pid).gte('scheduled_for', from).lt('scheduled_for', to).order('scheduled_for')) ?? [],
    audit: async (action, detail) => { await db.from('audit_logs').insert({ owner_id: uid, actor: uid, action, detail }) },
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'POST only')
  const who = await requireUser(req)
  if (who instanceof Response) return who
  const { user, db } = who
  let b: Record<string, any>
  try { b = await req.json() } catch { return json({ status: 'invalid_request', message: 'Expected JSON.' }, 400) }
  const store = dbStore(db, user.id)
  // `now` is the server clock. The client cannot choose "now", so it cannot backdate or bypass the "in the past" checks.
  const ctx = { userId: user.id, now: new Date(), language: typeof b.language === 'string' ? b.language : undefined }
  let out: unknown
  try {
    switch (b.action) {
      case 'create': out = await createReminderTool(store, ctx, {
        personId: b.personId, title: b.title, description: b.description, category: b.category, date: b.date, time: b.time, partOfDay: b.partOfDay,
        recurrence: b.recurrence, endsOn: b.endsOn, medicationId: b.medicationId, idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey.slice(0, 120) : undefined,
        source: b.source === 'app' || b.source === 'agent' ? b.source : 'voice',
      }); break
      case 'list_today': out = await listTodayTool(store, ctx, b.personId); break
      case 'snooze': out = await snoozeTool(store, ctx, b.reminderId, Number(b.minutes)); break
      case 'reschedule': out = await rescheduleTool(store, ctx, b.reminderId, { date: b.date, time: b.time }); break
      case 'cancel': out = await cancelTool(store, ctx, b.reminderId); break
      case 'skip': out = await skipTool(store, ctx, b.reminderId); break
      case 'complete': out = await completeTool(store, ctx, b.reminderId); break
      default: return json({ status: 'invalid_request', message: 'Unknown action.' }, 400)
    }
  } catch { console.error('reminders: unexpected failure'); return json({ status: 'temporary_failure', message: 'Something went wrong. The change was not saved.' }, 500) }
  const status = (out as { status: string }).status
  const http = status === 'permission_denied' ? 403 : status === 'invalid_request' ? 400 : status === 'temporary_failure' ? 503 : 200
  return json(out, http)
})
