// Thin wrapper around the browser's SpeechRecognition (Web Speech API).
//
// Chromium-based browsers and Safari ship `webkitSpeechRecognition`. Firefox
// has no implementation. `isSupported()` lets the UI decide whether to render
// the mic button at all.

type SR = typeof window & {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>
}

export function isSupported(): boolean {
  const w = window as SR
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition)
}

export interface VoiceSession {
  stop: () => void
  abort: () => void
}

export interface VoiceCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void
  onError?: (err: string) => void
  onEnd?: () => void
}

/** Start a recognition session. Calls `onTranscript` with the cumulative text
 *  every time the recognizer emits results (interim + final). */
export function startVoice(cb: VoiceCallbacks): VoiceSession {
  const w = window as SR
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!Ctor) throw new Error('SpeechRecognition not supported')

  const rec = new Ctor()
  rec.continuous = true
  rec.interimResults = true
  rec.lang = navigator.language || 'en-US'

  rec.onresult = (e) => {
    let text = ''
    let allFinal = true
    for (let i = 0; i < e.results.length; i++) {
      text += e.results[i][0].transcript
      if (!e.results[i].isFinal) allFinal = false
    }
    cb.onTranscript(text, allFinal)
  }
  rec.onerror = (e) => cb.onError?.(e.error)
  rec.onend = () => cb.onEnd?.()

  rec.start()

  return {
    stop: () => rec.stop(),
    abort: () => rec.abort(),
  }
}
