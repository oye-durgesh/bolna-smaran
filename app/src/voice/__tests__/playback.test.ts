import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Person } from '../../domain/types'

const speakRemote = vi.fn()
const browserSpeak = vi.fn()
const remoteVoiceAvailable = vi.fn()
vi.mock('../../services/ttsRemote', () => ({
  speakRemote: (...a: unknown[]) => speakRemote(...a),
  stopRemote: () => undefined,
  remoteVoiceAvailable: () => remoteVoiceAvailable(),
}))
vi.mock('../speech', () => ({
  speak: (...a: unknown[]) => browserSpeak(...a),
}))

import { playSathiLine, reminderVoicePersona } from '../playback'

const mum = { relationship: 'mother', sathiVoice: 'default' } as Person
const papa = { relationship: 'father', sathiVoice: 'default' } as Person
const mumAssigned = { relationship: 'mother', sathiVoice: 'dad' } as Person
const self = { relationship: 'self', sathiVoice: 'default' } as Person

describe('reminder voice mapping', () => {
  it('Mummy uses mom and Papa uses dad unless a different voice was assigned', () => {
    expect(reminderVoicePersona(mum)).toBe('mom')
    expect(reminderVoicePersona(papa)).toBe('dad')
    expect(reminderVoicePersona(mumAssigned)).toBe('dad')
    expect(reminderVoicePersona(self)).toBe('default')
    expect(reminderVoicePersona(undefined)).toBe('default')
  })
})

describe('playSathiLine', () => {
  beforeEach(() => {
    speakRemote.mockReset(); browserSpeak.mockReset(); remoteVoiceAvailable.mockReset()
    remoteVoiceAvailable.mockResolvedValue(true)
    speakRemote.mockImplementation((_t: string, o: { onEnd: () => void }) => { o.onEnd(); return Promise.resolve() })
    browserSpeak.mockImplementation((_a: string, _b: string, o: { onEnd: () => void }) => { o.onEnd(); return true })
  })
  const base = { say: 'नमस्ते', text: 'Namaste', lang: 'hi' as const, rate: 1, persona: 'mom' as const, muted: false, useServer: true, onError: vi.fn() }

  it('uses ElevenLabs TTS with the requested persona and does not play the browser voice', async () => {
    await playSathiLine(base)
    expect(speakRemote).toHaveBeenCalledWith('नमस्ते', expect.objectContaining({ persona: 'mom' }))
    expect(browserSpeak).not.toHaveBeenCalled()
    expect(base.onError).not.toHaveBeenCalled()
  })
  it('Papa’s persona is sent as dad, not mom', async () => {
    await playSathiLine({ ...base, persona: 'dad' })
    expect(speakRemote.mock.calls[0][1].persona).toBe('dad')
  })
  it('falls back to the browser voice and reports the error when TTS fails', async () => {
    speakRemote.mockImplementation((_t: string, o: { onError: (m: string) => void }) => { o.onError("Dad's voice is not set up on the server (ELEVENLABS_DAD_VOICE_ID is missing)."); return Promise.resolve() })
    await playSathiLine({ ...base, persona: 'dad' })
    expect(base.onError).toHaveBeenCalledWith(expect.stringMatching(/ELEVENLABS_DAD_VOICE_ID/))
    expect(browserSpeak).toHaveBeenCalled()
  })
  it('does not generate audio when muted', async () => {
    await playSathiLine({ ...base, muted: true })
    expect(speakRemote).not.toHaveBeenCalled()
    expect(browserSpeak).not.toHaveBeenCalled()
  })
  it('skips server TTS when it is turned off', async () => {
    await playSathiLine({ ...base, useServer: false })
    expect(speakRemote).not.toHaveBeenCalled()
    expect(browserSpeak).toHaveBeenCalled()
  })
})
