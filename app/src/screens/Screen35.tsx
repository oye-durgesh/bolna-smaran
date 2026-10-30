import { useVoice, voice } from '../voice/session'
import { SathiStage } from '../ui/SathiStage'
import { TextBar } from '../ui/callparts'

export default function Screen35() {
  const v = useVoice()
  return (
    <SathiStage state={v.muted ? 'muted' : 'listening'} seconds={v.seconds} caption={v.interim ? `${v.interim}…` : v.textMode ? 'Microphone is off. Type your reply below.' : undefined}
      onMic={() => voice.useText()} onMute={() => voice.toggleMute()} onEnd={() => voice.end()} extra={<TextBar v={v} />} />
  )
}
