import { useVoice, voice } from '../voice/session'
import { SathiStage } from '../ui/SathiStage'
import { TextBar } from '../ui/callparts'

export default function Screen36() {
  const v = useVoice()
  const line = v.speaking || v.lines.filter((l) => l.from === 'sathi').slice(-1)[0]?.text
  return (
    <SathiStage state={v.muted ? 'muted' : 'speaking'} seconds={v.seconds} caption={line ? `“${line}”` : undefined}
      onMic={() => voice.useText()} onMute={() => voice.toggleMute()} onEnd={() => voice.end()} extra={<TextBar v={v} />} />
  )
}
