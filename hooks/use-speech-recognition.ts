import * as React from "react"

type SpeechSegment = {
  id: string
  text: string
  ts: number
}

type UseSpeechRecognitionOptions = {
  lang?: string
  continuous?: boolean
  interimResults?: boolean
  autoRestart?: boolean
  debug?: boolean
}

type BrowserSpeechRecognitionResult = {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}

type BrowserSpeechRecognitionEvent = {
  readonly resultIndex: number
  readonly results: ArrayLike<BrowserSpeechRecognitionResult>
}

type BrowserSpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  start: () => void
  stop: () => void
}

declare global {
  interface Window {
    SpeechRecognition?: new () => BrowserSpeechRecognition
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition
  }
}

function makeSegmentId(index: number) {
  return `${Date.now()}-${index}`
}

export function useSpeechRecognition(options?: UseSpeechRecognitionOptions) {
  const {
    lang = "en-US",
    continuous = true,
    interimResults = true,
    autoRestart = true,
    debug = false,
  } = options ?? {}

  const recognitionRef = React.useRef<BrowserSpeechRecognition | null>(null)
  const restartTimerRef = React.useRef<number | null>(null)
  const shouldRestartRef = React.useRef(false)
  const recognitionActiveRef = React.useRef(false)
  const startInFlightRef = React.useRef(false)
  const retryAttemptRef = React.useRef(0)
  const restartDelayOverrideMsRef = React.useRef<number | null>(null)
  const segmentIndexRef = React.useRef(0)
  const lastFinalCombinedRef = React.useRef("")
  const lastErrorCodeRef = React.useRef<string | null>(null)

  const [supported, setSupported] = React.useState(false)
  const [listening, setListening] = React.useState(false)
  const [interimTranscript, setInterimTranscript] = React.useState("")
  const [finalSegments, setFinalSegments] = React.useState<SpeechSegment[]>([])
  const [lastError, setLastError] = React.useState<string | null>(null)
  const liveConsoleDebug = debug

  const log = React.useCallback(
    (...args: unknown[]) => {
      if (!debug) {
        return
      }
      console.log("[speech-recognition]", ...args)
    },
    [debug],
  )

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    setSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition))
  }, [])

  const clearRestartTimer = React.useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current)
      restartTimerRef.current = null
    }
  }, [])

  const scheduleRestart = React.useCallback(
    (delayMs: number, reason: string, restartFn: () => void) => {
      if (!shouldRestartRef.current) {
        return
      }
      clearRestartTimer()
      if (liveConsoleDebug) {
        console.log(`[live-transcription] retrying in ${delayMs}ms`, { reason })
      }
      restartTimerRef.current = window.setTimeout(() => {
        restartFn()
      }, delayMs)
    },
    [clearRestartTimer, liveConsoleDebug],
  )

  const ensureRecognition = React.useCallback(() => {
    if (typeof window === "undefined") {
      return null
    }

    if (recognitionRef.current) {
      return recognitionRef.current
    }

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognitionCtor) {
      return null
    }

    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = continuous
    recognition.interimResults = interimResults
    recognition.lang = lang

    recognition.onstart = () => {
      log("start")
      if (liveConsoleDebug) {
        console.log("[live-transcription] speech recognition started")
      }
      recognitionActiveRef.current = true
      startInFlightRef.current = false
      lastErrorCodeRef.current = null
      lastFinalCombinedRef.current = ""
      setListening(true)
      setLastError(null)
    }

    recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
      retryAttemptRef.current = 0
      restartDelayOverrideMsRef.current = null
      let interim = ""
      let combinedFinal = ""
      const finals: SpeechSegment[] = []

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (!result) {
          continue
        }

        const text = `${result[0]?.transcript ?? ""}`.trim()
        if (!text) {
          continue
        }

        if (result.isFinal) {
          combinedFinal = `${combinedFinal} ${text}`.trim()
        } else {
          interim = `${interim} ${text}`.trim()
        }
      }

      if (combinedFinal && combinedFinal !== lastFinalCombinedRef.current) {
        const delta = combinedFinal.startsWith(lastFinalCombinedRef.current)
          ? combinedFinal.slice(lastFinalCombinedRef.current.length).trim()
          : combinedFinal

        if (delta) {
          finals.push({
            id: makeSegmentId(segmentIndexRef.current),
            text: delta,
            ts: Date.now(),
          })
          segmentIndexRef.current += 1
        }

        lastFinalCombinedRef.current = combinedFinal
      }

      setInterimTranscript(interim)
      if (liveConsoleDebug && interim) {
        console.log("[live-transcription][interim]", interim)
      }
      if (finals.length > 0) {
        if (liveConsoleDebug) {
          console.log("[live-transcription] transcript received")
        }
        if (liveConsoleDebug) {
          finals.forEach((segment) => {
            console.log("[live-transcription][final]", segment.text)
          })
        }
        setFinalSegments((prev) => [...prev, ...finals].slice(-200))
      }
    }

    recognition.onerror = (event: { error?: string }) => {
      const code = event.error ?? "unknown"
      lastErrorCodeRef.current = code
      log("error", code)
      if (liveConsoleDebug) {
        console.log("[live-transcription][error]", code)
      }
      setLastError(code)

      if (code === "not-allowed" || code === "service-not-allowed") {
        shouldRestartRef.current = false
        recognitionActiveRef.current = false
        startInFlightRef.current = false
        return
      }

      if (code === "network") {
        retryAttemptRef.current += 1
        const delay = Math.min(10000, 1200 * 2 ** Math.min(retryAttemptRef.current, 3))
        restartDelayOverrideMsRef.current = delay
        if (liveConsoleDebug) {
          console.log(`[live-transcription] network error backoff ${delay}ms`)
        }

        const stopRecognition = () => {
          try {
            recognition.stop()
          } catch {
            // no-op
          }
        }

        if (recognitionActiveRef.current || startInFlightRef.current) {
          stopRecognition()
        } else if (autoRestart && shouldRestartRef.current) {
          scheduleRestart(delay, "network-error", () => {
            if (recognitionActiveRef.current || startInFlightRef.current) {
              if (liveConsoleDebug) {
                console.log("[live-transcription] recognition already active")
              }
              return
            }
            try {
              startInFlightRef.current = true
              recognition.start()
            } catch (error) {
              startInFlightRef.current = false
              log("restart failed", error)
              setListening(false)
            }
          })
        }
      }
    }

    recognition.onend = () => {
      log("end", { shouldRestart: shouldRestartRef.current, autoRestart })
      if (liveConsoleDebug) {
        console.log("[live-transcription] speech recognition ended")
      }
      recognitionActiveRef.current = false
      startInFlightRef.current = false
      if (autoRestart && shouldRestartRef.current) {
        const delay = restartDelayOverrideMsRef.current ?? 1500
        if (
          lastErrorCodeRef.current === "not-allowed" ||
          lastErrorCodeRef.current === "service-not-allowed"
        ) {
          setListening(false)
          return
        }
        setListening(false)
        scheduleRestart(delay, "recognition-ended", () => {
          if (recognitionActiveRef.current || startInFlightRef.current) {
            if (liveConsoleDebug) {
              console.log("[live-transcription] recognition already active")
            }
            return
          }
          try {
            startInFlightRef.current = true
            recognition.start()
          } catch (error) {
            startInFlightRef.current = false
            log("restart failed", error)
            setListening(false)
          }
        })
        return
      }

      setListening(false)
    }

    recognitionRef.current = recognition
    return recognition
  }, [autoRestart, clearRestartTimer, continuous, interimResults, lang, log, scheduleRestart])

  const start = React.useCallback(async () => {
    const recognition = ensureRecognition()
    if (!recognition) {
      setLastError("unsupported")
      return false
    }

    if (recognitionActiveRef.current || startInFlightRef.current) {
      if (liveConsoleDebug) {
        console.log("[live-transcription] recognition already active")
      }
      return true
    }

    shouldRestartRef.current = true
    clearRestartTimer()
    retryAttemptRef.current = 0
    restartDelayOverrideMsRef.current = null
    lastErrorCodeRef.current = null

    try {
      startInFlightRef.current = true
      recognition.start()
      if (liveConsoleDebug) {
        console.log("[live-transcription] start requested")
      }
      return true
    } catch (error) {
      startInFlightRef.current = false
      log("start failed", error)
      setLastError("start-failed")
      setListening(false)
      return false
    }
  }, [clearRestartTimer, ensureRecognition, log])

  const stop = React.useCallback(() => {
    shouldRestartRef.current = false
    clearRestartTimer()
    restartDelayOverrideMsRef.current = null
    retryAttemptRef.current = 0
    recognitionActiveRef.current = false
    startInFlightRef.current = false

    if (!recognitionRef.current) {
      setListening(false)
      return
    }

    try {
      recognitionRef.current.stop()
      if (liveConsoleDebug) {
        console.log("[live-transcription] stop requested")
      }
    } catch (error) {
      log("stop failed", error)
    } finally {
      setListening(false)
    }
  }, [clearRestartTimer, log])

  const reset = React.useCallback(() => {
    setInterimTranscript("")
    setFinalSegments([])
    setLastError(null)
    lastFinalCombinedRef.current = ""
    segmentIndexRef.current = 0
    retryAttemptRef.current = 0
    restartDelayOverrideMsRef.current = null
    lastErrorCodeRef.current = null
  }, [])

  React.useEffect(
    () => () => {
      shouldRestartRef.current = false
      clearRestartTimer()
      recognitionActiveRef.current = false
      startInFlightRef.current = false
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch {
          // no-op
        }
      }
      recognitionRef.current = null
    },
    [clearRestartTimer],
  )

  return {
    supported,
    listening,
    interimTranscript,
    finalSegments,
    start,
    stop,
    reset,
    lastError,
  }
}
