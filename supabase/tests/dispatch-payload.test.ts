import { describe, expect, it } from 'vitest'
import { buildPayload, shouldPush } from '../functions/_shared/dispatch-payload.ts'
const mum = { greeting_name: 'Mummy', display_name: 'Sunita', relationship: 'mother', notifications_enabled: true }
describe('dispatch payload', () => {
  it('names the profile and never the medicine on the lock screen', () => {
    expect(buildPayload({ id: 'r1', kind: 'medicine', title: 'Metformin 500mg' }, mum)).toEqual({ reminderId: 'r1', title: "Time for Mummy's medicine", body: 'Tap to answer Sathi' })
    expect(JSON.stringify(buildPayload({ id: 'r1', kind: 'medicine', title: 'Metformin 500mg' }, mum))).not.toMatch(/metformin/i)
  })
  it('custom reminders show their own title with the profile name; the account holder’s own reminders stay plain', () => {
    expect(buildPayload({ id: 'r2', kind: 'custom', title: 'Go for a walk' }, mum).title).toBe('Mummy: Go for a walk')
    expect(buildPayload({ id: 'r3', kind: 'custom', title: 'Go for a walk' }, { ...mum, relationship: 'self' }).title).toBe('Go for a walk')
    expect(buildPayload({ id: 'r4', kind: 'medicine', title: 'x' }, null).title).toBe('Time for your medicine')
  })
  it('falls back to the display name when there is no greeting name', () => {
    expect(buildPayload({ id: 'r5', kind: 'custom', title: 'Walk' }, { ...mum, greeting_name: '' }).title).toBe('Sunita: Walk')
  })
  it('a profile with notifications off is not pushed to; unknown profile or on is', () => {
    expect(shouldPush({ ...mum, notifications_enabled: false })).toBe(false)
    expect(shouldPush(mum)).toBe(true); expect(shouldPush(null)).toBe(true)
  })
})
