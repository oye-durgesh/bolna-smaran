/** Reminder tool logic against an IN-MEMORY store (a mock of the database boundary). The SQL guarantees are tested in db.test.ts. */
import { beforeEach, describe, expect, it } from 'vitest'
import { skipTool, cancelTool, completeTool, createReminderTool, listTodayTool, rescheduleTool, snoozeTool, StoreError } from '../functions/_shared/reminder-tool.ts'
import type { MedRow, PersonRow, ReminderRow, ToolStore } from '../functions/_shared/reminder-tool.ts'

const ME = 'user-durgesh', OTHER = 'user-other'
const NOW = new Date('2026-10-29T10:00:00Z') // 15:30 IST
const person = (id: string, owner = ME, tz = 'Asia/Kolkata', active = true): PersonRow => ({ id, owner_id: owner, active, time_zone: tz, display_name: id, greeting_name: id, language: 'hi' })
function memStore(opts: { people?: PersonRow[]; meds?: MedRow[]; failInsert?: boolean; failRead?: boolean } = {}) {
  const people = opts.people ?? [person('per_mum'), person('per_papa'), person('per_stranger', OTHER)]
  const rows = new Map<string, ReminderRow>(), series: Record<string, unknown>[] = [], audit: string[] = []
  const store: ToolStore = {
    getPerson: async (id) => { if (opts.failRead) throw new Error('db down'); return people.find((p) => p.id === id) ?? null },
    getMedication: async (id) => (opts.meds ?? []).find((m) => m.id === id) ?? null,
    findReminderByKey: async (o, k) => [...rows.values()].find((r) => r.owner_id === o && r.idempotency_key === k) ?? null,
    getReminder: async (id) => rows.get(id) ?? null,
    insertReminder: async (r) => {
      if (opts.failInsert) throw new StoreError('unavailable', 'db down')
      if (rows.has(r.id) || [...rows.values()].some((x) => x.owner_id === r.owner_id && x.idempotency_key === r.idempotency_key)) throw new StoreError('conflict', 'dup')
      rows.set(r.id, r); return r
    },
    insertSeries: async (s) => { if (!series.some((x) => x.id === s.id)) series.push(s) },
    updateReminder: async (id, patch) => { const n = { ...rows.get(id)!, ...patch }; rows.set(id, n); return n },
    listReminders: async (pid, from, to) => [...rows.values()].filter((r) => r.person_id === pid && r.scheduled_for >= from && r.scheduled_for < to),
    audit: async (a, d) => { audit.push(`${a} ${d}`) },
  }
  return { store, rows, series, audit }
}
const ctx = (language = 'en') => ({ userId: ME, now: NOW, language })
let m: ReturnType<typeof memStore>
beforeEach(() => { m = memStore() })

describe('create: one-time', () => {
  it('"Remind me to go for a walk at 6 PM" → saved under Mummy, 18:00 IST today, with her time zone', async () => {
    const r = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Go for a walk', time: '18:00' })
    expect(r).toMatchObject({ status: 'saved', reminder: { personId: 'per_mum', title: 'Go for a walk', scheduledFor: '2026-10-29T12:30:00.000Z', timeZone: 'Asia/Kolkata', localTime: '18:00', localDate: '2026-10-29', recurrence: 'none' } })
    expect([...m.rows.values()][0]).toMatchObject({ owner_id: ME, person_id: 'per_mum', status: 'scheduled', source: 'voice', created_by: ME, delivery_channel: 'push' })
    expect(m.audit[0]).toMatch(/reminder_created_by_voice/); expect(m.audit.join()).not.toMatch(/walk/i) // the audit trail carries ids, not the text
  })
  it('uses the PROFILE’s time zone, not the server’s or the caller’s', async () => {
    m = memStore({ people: [person('per_uk', ME, 'Europe/London')] })
    const r = await createReminderTool(m.store, ctx(), { personId: 'per_uk', title: 'Walk', time: '18:00', date: 'tomorrow' })
    expect(r).toMatchObject({ status: 'saved', reminder: { scheduledFor: '2026-10-30T18:00:00.000Z', timeZone: 'Europe/London' } })
  })
  it('"tomorrow" and explicit dates are resolved in the profile zone', async () => {
    const a = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Doctor', time: '07:00', date: 'tomorrow' })
    expect(a).toMatchObject({ status: 'saved', reminder: { localDate: '2026-10-30', localTime: '07:00' } })
    const b = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Lab', time: '07:00', date: '2026-11-02' })
    expect(b).toMatchObject({ status: 'saved', reminder: { localDate: '2026-11-02' } })
  })
})

describe('create: recurring', () => {
  it('"every day at 6 PM" makes a series plus its first occurrence, using the scheduler’s id/key scheme', async () => {
    const r = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Go for a walk', time: '18:00', recurrence: 'daily' })
    expect(r).toMatchObject({ status: 'saved', reminder: { recurrence: 'daily', localDate: '2026-10-29' } })
    expect(m.series).toHaveLength(1)
    const row = [...m.rows.values()][0]
    expect(row.series_id).toBe(m.series[0].id)
    expect(row.id).toBe(`rem_series:${row.series_id}:2026-10-29`); expect(row.idempotency_key).toBe(`series:${row.series_id}:2026-10-29`)
    expect(m.series[0]).toMatchObject({ person_id: 'per_mum', local_time: '18:00', time_zone: 'Asia/Kolkata', active: true })
  })
  it('daily with a time that already passed today starts tomorrow instead of failing', async () => {
    const r = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Water', time: '09:00', recurrence: 'daily' })
    expect(r).toMatchObject({ status: 'saved', reminder: { localDate: '2026-10-30' } })
  })
})

describe('clarification instead of guessing', () => {
  it('missing time → asks one question, saves nothing', async () => {
    const r = await createReminderTool(m.store, ctx('hi'), { personId: 'per_mum', title: 'Walk' })
    expect(r).toMatchObject({ status: 'needs_clarification', missing: 'time', question: 'Kitne baje yaad dilaun?' })
    expect(m.rows.size).toBe(0)
  })
  it('only "shaam" (no clock time) is still a question', async () => {
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', partOfDay: 'evening' })).toMatchObject({ status: 'needs_clarification', missing: 'time' })
  })
  it('missing title / person', async () => {
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', time: '18:00' })).toMatchObject({ status: 'needs_clarification', missing: 'title' })
    expect(await createReminderTool(m.store, ctx(), { personId: '', title: 'x', time: '18:00' })).toMatchObject({ status: 'needs_clarification', missing: 'person' })
  })
  it('a one-time time that already passed today → asks about tomorrow rather than inventing a date', async () => {
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '09:00' })).toMatchObject({ status: 'needs_clarification', missing: 'date' })
    expect(m.rows.size).toBe(0)
  })
})

describe('validation', () => {
  it.each([
    [{ time: '25:00' }, 'time'], [{ time: '6pm' }, 'time'], [{ time: '18:00', date: '2026-02-30' }, 'date'], [{ time: '18:00', date: 'someday' }, 'date'],
    [{ time: '09:00', date: '2026-10-01' }, 'time'], [{ time: '18:00', recurrence: 'weekly' as never }, 'recurrence'], [{ time: '18:00', category: 'bogus' as never }, 'category'],
  ])('%j → invalid_request on %s', async (extra, field) => {
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', ...extra })).toMatchObject({ status: 'invalid_request', field })
  })
  it('refuses an over-long title', async () => {
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'x'.repeat(201), time: '18:00' })).toMatchObject({ status: 'invalid_request', field: 'title' })
  })
  it('endsOn before the start is rejected', async () => {
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00', recurrence: 'daily', endsOn: '2026-10-01' })).toMatchObject({ status: 'invalid_request', field: 'endsOn' })
  })
})

describe('authorisation', () => {
  it('a person that belongs to another account, does not exist, or is archived is permission_denied — nothing is written', async () => {
    m = memStore({ people: [person('per_stranger', OTHER), person('per_old', ME, 'Asia/Kolkata', false)] })
    for (const id of ['per_stranger', 'per_ghost', 'per_old'])
      expect(await createReminderTool(m.store, ctx(), { personId: id, title: 'Walk', time: '18:00' })).toMatchObject({ status: 'permission_denied' })
    expect(m.rows.size).toBe(0)
  })
  it('the model cannot choose the owner: ownership always comes from the verified context', async () => {
    await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00', ...({ owner_id: OTHER, userId: OTHER } as object) })
    expect([...m.rows.values()][0].owner_id).toBe(ME)
  })
  it('Mummy’s reminder is never saved under Papa, and each person sees only their own list', async () => {
    await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00' })
    await createReminderTool(m.store, ctx(), { personId: 'per_papa', title: 'BP check', time: '21:00' })
    const mum = await listTodayTool(m.store, ctx(), 'per_mum'), papa = await listTodayTool(m.store, ctx(), 'per_papa')
    expect(mum).toMatchObject({ status: 'ok', reminders: [{ title: 'Walk', personId: 'per_mum' }] })
    expect(papa).toMatchObject({ status: 'ok', reminders: [{ title: 'BP check', personId: 'per_papa' }] })
    expect(await listTodayTool(m.store, ctx(), 'per_stranger')).toMatchObject({ status: 'permission_denied' })
  })
})

describe('medicine reminders use only confirmed medicine records', () => {
  const med = (o: Partial<MedRow> = {}): MedRow => ({ id: 'med1', owner_id: ME, person_id: 'per_mum', status: 'active', name: 'Metformin 500mg', ...o })
  it('active medicine of the same person → title is the record’s name; no dose is invented', async () => {
    m = memStore({ meds: [med()] })
    const r = await createReminderTool(m.store, ctx(), { personId: 'per_mum', category: 'medicine', medicationId: 'med1', time: '08:00', recurrence: 'daily' })
    expect(r).toMatchObject({ status: 'saved', reminder: { title: 'Metformin 500mg' } })
    expect([...m.rows.values()][0]).toMatchObject({ kind: 'medicine', medication_id: 'med1' })
  })
  it('medicine of another person, an unconfirmed (draft) medicine, or no medicine id are refused / clarified', async () => {
    m = memStore({ meds: [med({ person_id: 'per_papa' }), med({ id: 'med2', status: 'draft' })] })
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', category: 'medicine', medicationId: 'med1', time: '08:00' })).toMatchObject({ status: 'permission_denied' })
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', category: 'medicine', medicationId: 'med2', time: '08:00' })).toMatchObject({ status: 'invalid_request' })
    expect(await createReminderTool(m.store, ctx(), { personId: 'per_mum', category: 'medicine', time: '08:00' })).toMatchObject({ status: 'needs_clarification', missing: 'medicine' })
    expect(m.rows.size).toBe(0)
  })
})

describe('idempotency and failures', () => {
  it('the same tool call retried returns "duplicate" and creates nothing new (explicit key, and derived key)', async () => {
    const a = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00', idempotencyKey: 'call-1' })
    const b = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00', idempotencyKey: 'call-1' })
    expect(a.status).toBe('saved'); expect(b).toMatchObject({ status: 'duplicate' }); expect(m.rows.size).toBe(1)
    const c = await createReminderTool(m.store, ctx(), { personId: 'per_papa', title: 'Walk', time: '18:00' })
    const d = await createReminderTool(m.store, ctx(), { personId: 'per_papa', title: '  walk ', time: '18:00' })
    expect(c.status).toBe('saved'); expect(d.status).toBe('duplicate'); expect(m.rows.size).toBe(2)
  })
  it('two simultaneous identical calls: one saved, the other a duplicate (the unique constraint decides)', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00', idempotencyKey: 'race' })))
    expect([a.status, b.status].sort()).toEqual(['duplicate', 'saved']); expect(m.rows.size).toBe(1)
  })
  it('a database failure is temporary_failure — never "saved"', async () => {
    m = memStore({ failInsert: true })
    const r = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00' })
    expect(r.status).toBe('temporary_failure'); expect(m.rows.size).toBe(0)
    m = memStore({ failRead: true })
    expect((await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00' })).status).toBe('temporary_failure')
  })
})

describe('manage', () => {
  let id: string
  beforeEach(async () => { const r = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Walk', time: '18:00' }); id = (r as { reminder: { id: string } }).reminder.id })
  it('snooze moves the same row, records history, and accepts only 5/10/15', async () => {
    expect(await snoozeTool(m.store, ctx(), id, 10)).toMatchObject({ status: 'saved', reminder: { status: 'snoozed', scheduledFor: '2026-10-29T10:10:00.000Z' } })
    expect(m.rows.size).toBe(1); expect(m.rows.get(id)!.snooze_history).toHaveLength(1)
    expect(await snoozeTool(m.store, ctx(), id, 7)).toMatchObject({ status: 'invalid_request', field: 'minutes' })
  })
  it('reschedule keeps the row and the person; a past time is refused', async () => {
    expect(await rescheduleTool(m.store, ctx(), id, { date: 'tomorrow', time: '07:30' })).toMatchObject({ status: 'saved', reminder: { localDate: '2026-10-30', localTime: '07:30', personId: 'per_mum' } })
    expect(await rescheduleTool(m.store, ctx(), id, { time: '09:00' })).toMatchObject({ status: 'invalid_request', field: 'time' })
    expect(await rescheduleTool(m.store, ctx(), id, {})).toMatchObject({ status: 'needs_clarification' })
  })
  it('complete is recorded as user-reported; cancel works once; neither works on a closed reminder', async () => {
    expect(await completeTool(m.store, ctx(), id)).toMatchObject({ status: 'saved', reminder: { status: 'completed' } })
    expect(m.rows.get(id)!.completion).toEqual({ via: 'voice', basis: 'user-reported' })
    expect(await cancelTool(m.store, ctx(), id)).toMatchObject({ status: 'invalid_request' })
    const r2 = await createReminderTool(m.store, ctx(), { personId: 'per_mum', title: 'Water', time: '19:00' })
    expect(await cancelTool(m.store, ctx(), (r2 as any).reminder.id)).toMatchObject({ status: 'saved', reminder: { status: 'cancelled' } })
  })
  it('skip records a skipped dose (not completed, not missed) and cannot be repeated', async () => {
    expect(await skipTool(m.store, ctx(), id)).toMatchObject({ status: 'saved', reminder: { status: 'skipped' } })
    expect(m.rows.get(id)).toMatchObject({ status: 'skipped', skipped_at: NOW.toISOString() }); expect(m.rows.get(id)!.completion).toBeUndefined()
    expect(await skipTool(m.store, ctx(), id)).toMatchObject({ status: 'invalid_request' })
    expect(m.audit.some((a) => a.startsWith('reminder_skipped'))).toBe(true)
  })
  it('another account cannot touch the reminder; unknown ids are permission_denied', async () => {
    const other = { userId: OTHER, now: NOW }
    expect(await cancelTool(m.store, other, id)).toMatchObject({ status: 'permission_denied' })
    expect(await snoozeTool(m.store, ctx(), 'rem_nope', 10)).toMatchObject({ status: 'permission_denied' })
    expect(m.rows.get(id)!.status).toBe('scheduled')
  })
  it('changes to a reminder of an ARCHIVED profile are refused', async () => {
    m = memStore({ people: [person('per_mum', ME, 'Asia/Kolkata', false)] })
    m.rows.set('r1', { id: 'r1', owner_id: ME, person_id: 'per_mum', kind: 'custom', title: 'x', notes: null, medication_id: null, series_id: null, scheduled_for: NOW.toISOString(), original_scheduled_for: NOW.toISOString(), time_zone: 'Asia/Kolkata', recurrence: null, status: 'scheduled', idempotency_key: 'k', source: 'app', created_by: ME, delivery_channel: 'push' })
    expect(await cancelTool(m.store, ctx(), 'r1')).toMatchObject({ status: 'permission_denied' })
  })
})
