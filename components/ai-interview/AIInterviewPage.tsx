"use client";

import { AlertTriangle, Loader2, Mic, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AIAvatar } from "@/components/ai-interview/AIAvatar";
import { LiveTranscriptPanel } from "@/components/ai-interview/LiveTranscriptPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ProctoringService, type ProctoringViolation } from "@/lib/ai-interview/ProctoringService";
import { SpeechRecognitionService } from "@/lib/ai-interview/SpeechRecognitionService";
import { SpeechSynthesisService } from "@/lib/ai-interview/SpeechSynthesisService";

type TranscriptItem = {
  id: string;
  speaker: "AI" | "CANDIDATE";
  text: string;
  timestamp: string;
  questionIdx: number | null;
  isFollowUp: boolean;
};

type SessionState = {
  sessionId: string;
  status: "IN_PROGRESS" | "COMPLETED";
  maxQuestions: number;
  askedQuestions: number;
  candidateResponses: number;
  transcript: TranscriptItem[];
  nextQuestion: string | null;
  evaluation: {
    aiScore: number;
    finalScore: number;
    summary: string;
    strengths: string[];
    weaknesses: string[];
    malpracticePenalty: number;
  } | null;
};

type AIInterviewPageProps = {
  meetingRoomId: string;
  roundTitle: string;
};

const SUBMIT_DELAY_MS = 5000;

async function hashViolationEvent(event: ProctoringViolation) {
  const payload = `${event.type}|${event.durationSec}|${event.timestamp}`;
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(payload));
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((item) => item.toString(16).padStart(2, "0")).join("");
}

function errorToMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong";
}

export function AIInterviewPage({ meetingRoomId, roundTitle }: AIInterviewPageProps) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [pendingCandidateText, setPendingCandidateText] = useState("");
  const [listening, setListening] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [warningBanner, setWarningBanner] = useState<string | null>(null);
  const [submitCountdownSec, setSubmitCountdownSec] = useState<number | null>(null);

  const recognitionRef = useRef<SpeechRecognitionService | null>(null);
  const synthesisRef = useRef<SpeechSynthesisService | null>(null);
  const proctoringRef = useRef<ProctoringService | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const pendingAnswerRef = useRef("");
  const latestInterimRef = useRef("");
  const answerFlushTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  const countdownDeadlineRef = useRef<number | null>(null);
  const pendingProctorEventsRef = useRef<Array<ProctoringViolation & { hash: string }>>([]);
  const proctorFlushTimerRef = useRef<number | null>(null);
  const lastSpokenTurnIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const progressPercent = useMemo(() => {
    if (!sessionState) {
      return 0;
    }
    return Math.min(100, Math.round((sessionState.candidateResponses / sessionState.maxQuestions) * 100));
  }, [sessionState]);
  const liveCandidateDraft = useMemo(
    () => `${pendingCandidateText} ${interimTranscript}`.trim(),
    [interimTranscript, pendingCandidateText],
  );

  const clearAnswerTimer = useCallback(() => {
    if (answerFlushTimerRef.current !== null) {
      window.clearTimeout(answerFlushTimerRef.current);
      answerFlushTimerRef.current = null;
    }
  }, []);

  const clearCountdownUi = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    countdownDeadlineRef.current = null;
    setSubmitCountdownSec(null);
  }, []);

  const clearProctorTimer = useCallback(() => {
    if (proctorFlushTimerRef.current !== null) {
      window.clearTimeout(proctorFlushTimerRef.current);
      proctorFlushTimerRef.current = null;
    }
  }, []);

  const speakTurn = useCallback(async (turn: TranscriptItem | null) => {
    if (!turn || turn.speaker !== "AI") {
      return;
    }

    if (lastSpokenTurnIdRef.current === turn.id) {
      return;
    }

    lastSpokenTurnIdRef.current = turn.id;
    recognitionRef.current?.stop();
    await synthesisRef.current?.speak(turn.text);

    if (mountedRef.current && sessionState?.status !== "COMPLETED") {
      void recognitionRef.current?.start();
    }
  }, [sessionState?.status]);

  const hydrateSession = useCallback(
    async (speakLatestAiTurn: boolean) => {
      const response = await fetch(`/api/ai-interview/${meetingRoomId}`, {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: SessionState;
      };

      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error ?? "Unable to load AI interview session");
      }

      if (!mountedRef.current) {
        return;
      }

      setSessionState(payload.data);
      setTranscript(payload.data.transcript);
      setError(null);

      if (payload.data.status === "COMPLETED") {
        recognitionRef.current?.stop();
      } else if (speakLatestAiTurn) {
        const latestAiTurn = [...payload.data.transcript]
          .reverse()
          .find((turn) => turn.speaker === "AI");
        await speakTurn(latestAiTurn ?? null);
      }
    },
    [meetingRoomId, speakTurn],
  );

  const flushProctorEvents = useCallback(async () => {
    if (pendingProctorEventsRef.current.length === 0) {
      return;
    }

    const events = [...pendingProctorEventsRef.current];
    pendingProctorEventsRef.current = [];

    try {
      await fetch(`/api/ai-interview/${meetingRoomId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "proctor",
          events,
        }),
      });
    } catch {
      pendingProctorEventsRef.current.push(...events);
    }
  }, [meetingRoomId]);

  const queueProctorEvent = useCallback(async (event: ProctoringViolation) => {
    const hash = await hashViolationEvent(event);
    pendingProctorEventsRef.current.push({ ...event, hash });

    setWarningBanner("Please focus on the interview screen. Suspicious activity detected.");
    window.setTimeout(() => {
      if (mountedRef.current) {
        setWarningBanner(null);
      }
    }, 2800);

    clearProctorTimer();
    proctorFlushTimerRef.current = window.setTimeout(() => {
      void flushProctorEvents();
    }, 1200);
  }, [clearProctorTimer, flushProctorEvents]);

  const submitCandidateResponse = useCallback(async () => {
    if (submitting) {
      return;
    }

    const text = pendingAnswerRef.current.trim() || latestInterimRef.current.trim();
    if (!text) {
      clearCountdownUi();
      return;
    }

    pendingAnswerRef.current = "";
    setInterimTranscript("");
    latestInterimRef.current = "";
    clearCountdownUi();
    setSubmitting(true);

    recognitionRef.current?.stop();

    try {
      const response = await fetch(`/api/ai-interview/${meetingRoomId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "answer",
          answerText: text,
        }),
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: SessionState;
      };

      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error ?? "Unable to submit response");
      }

      if (!mountedRef.current) {
        return;
      }

      setSessionState(payload.data);
      setTranscript(payload.data.transcript);
      setPendingCandidateText("");

      const latestAiTurn = [...payload.data.transcript]
        .reverse()
        .find((turn) => turn.speaker === "AI");

      await speakTurn(latestAiTurn ?? null);

      if (payload.data.status === "COMPLETED") {
        toast.success("AI interview completed");
        setTimeout(() => {
          router.replace("/dashboard");
          router.refresh();
        }, 1800);
      }
    } catch (submitError) {
      const message = errorToMessage(submitError);
      toast.error(message);
      setError(message);
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }, [clearCountdownUi, meetingRoomId, router, speakTurn, submitting]);

  const scheduleAnswerFlush = useCallback(() => {
    if (submitting) {
      return;
    }

    if (!pendingAnswerRef.current.trim()) {
      return;
    }

    clearAnswerTimer();
    clearCountdownUi();
    const deadline = Date.now() + SUBMIT_DELAY_MS;
    countdownDeadlineRef.current = deadline;
    setSubmitCountdownSec(Math.ceil(SUBMIT_DELAY_MS / 1000));

    countdownIntervalRef.current = window.setInterval(() => {
      if (!countdownDeadlineRef.current) {
        return;
      }
      const msLeft = countdownDeadlineRef.current - Date.now();
      if (msLeft <= 0) {
        clearCountdownUi();
        return;
      }
      setSubmitCountdownSec(Math.ceil(msLeft / 1000));
    }, 250);

    answerFlushTimerRef.current = window.setTimeout(() => {
      clearCountdownUi();
      void submitCandidateResponse();
    }, SUBMIT_DELAY_MS);
  }, [clearAnswerTimer, clearCountdownUi, submitCandidateResponse, submitting]);

  useEffect(() => {
    mountedRef.current = true;

    synthesisRef.current = new SpeechSynthesisService({
      pitch: 1,
      rate: 0.95,
      onSpeakingChange: setAiSpeaking,
    });

    recognitionRef.current = new SpeechRecognitionService({
      lang: "en-US",
      debug: process.env.NEXT_PUBLIC_DEBUG_TRANSCRIPTION === "1",
      onInterim: (text) => {
        if (!mountedRef.current) {
          return;
        }
        setInterimTranscript(text);
        latestInterimRef.current = text;
        if (text.trim() && pendingAnswerRef.current.trim()) {
          scheduleAnswerFlush();
        }
      },
      onFinal: (text) => {
        if (!mountedRef.current) {
          return;
        }
        const merged = `${pendingAnswerRef.current} ${text}`.trim();
        pendingAnswerRef.current = merged;
        setPendingCandidateText(merged);
        setInterimTranscript("");
        latestInterimRef.current = "";
        scheduleAnswerFlush();
      },
      onError: (code) => {
        if (!mountedRef.current) {
          return;
        }
        if (code === "network") {
          toast.error("Transcription network issue. Check microphone/network and retry.");
        }
      },
      onListeningChange: (value) => {
        if (mountedRef.current) {
          setListening(value);
        }
      },
    });

    const setup = async () => {
      try {
        await hydrateSession(true);

        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            width: { ideal: 640 },
            height: { ideal: 360 },
            facingMode: "user",
          },
        });

        if (!mountedRef.current) {
          return;
        }

        mediaStreamRef.current = mediaStream;
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = mediaStream;
          void previewVideoRef.current.play().catch(() => undefined);
        }

        const proctoring = new ProctoringService({
          fps: 10,
          debug: process.env.NEXT_PUBLIC_DEBUG_TRANSCRIPTION === "1",
          onViolation: (event) => {
            void queueProctorEvent(event);
          },
        });

        await proctoring.init(previewVideoRef.current as HTMLVideoElement);
        proctoring.start();
        proctoringRef.current = proctoring;
      } catch (setupError) {
        const message = errorToMessage(setupError);
        if (mountedRef.current) {
          setError(message);
          toast.error(message);
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    };

    void setup();

    return () => {
      mountedRef.current = false;
      clearAnswerTimer();
      clearCountdownUi();
      clearProctorTimer();
      recognitionRef.current?.destroy();
      synthesisRef.current?.cancel();
      proctoringRef.current?.destroy();
      void flushProctorEvents();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [clearAnswerTimer, clearCountdownUi, clearProctorTimer, flushProctorEvents, hydrateSession, queueProctorEvent, scheduleAnswerFlush]);

  return (
    <main className="fixed inset-0 z-[80] h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-zinc-400">AI Interview Mode</p>
            <h1 className="text-lg font-semibold">{roundTitle}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={listening ? "default" : "secondary"}>
              <Mic className="mr-1 h-3.5 w-3.5" />
              {listening ? "Listening" : "Idle"}
            </Badge>
            <Badge variant={aiSpeaking ? "default" : "secondary"}>AI {aiSpeaking ? "Speaking" : "Waiting"}</Badge>
          </div>
        </header>

        {warningBanner && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              {warningBanner}
            </div>
          </div>
        )}

        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="min-h-0 border-zinc-800 bg-zinc-900/80">
            <CardHeader>
              <CardTitle className="text-base">AI Interviewer</CardTitle>
            </CardHeader>
            <CardContent className="flex h-[calc(100%-4rem)] flex-col gap-4">
              <AIAvatar speaking={aiSpeaking} />
              <Separator className="bg-zinc-800" />
              <div className="space-y-2 text-sm text-zinc-300">
                <div className="flex items-center justify-between">
                  <span>Interview Progress</span>
                  <span>{progressPercent}%</span>
                </div>
                <Progress value={progressPercent} className="h-2" />
              </div>
              <video ref={previewVideoRef} muted playsInline className="hidden" />
            </CardContent>
          </Card>

          <div className="grid min-h-0 gap-4 lg:grid-rows-[minmax(0,1fr)_auto]">
            <LiveTranscriptPanel
              transcript={transcript}
              liveCandidateText={liveCandidateDraft}
              currentQuestion={sessionState?.candidateResponses ?? 0}
              maxQuestions={sessionState?.maxQuestions ?? 5}
            />

            {sessionState?.status === "COMPLETED" && sessionState.evaluation ? (
              <Card className="border-zinc-800 bg-zinc-900/80">
                <CardHeader>
                  <CardTitle className="text-base">Interview Result</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1 text-sm">
                    <p>
                      <span className="font-medium">AI Score:</span> {sessionState.evaluation.aiScore}
                    </p>
                    <p>
                      <span className="font-medium">Malpractice Penalty:</span> -{sessionState.evaluation.malpracticePenalty}
                    </p>
                    <p>
                      <span className="font-medium">Final Score:</span> {sessionState.evaluation.finalScore}
                    </p>
                  </div>
                  <p className="text-sm text-zinc-300">{sessionState.evaluation.summary}</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-zinc-800 bg-zinc-900/80">
                <CardContent className="flex items-center justify-between gap-3 py-4 text-sm text-zinc-300">
                  <div className="space-y-1">
                    <span>
                      {submitting
                        ? "Submitting captured speech..."
                        : "Live capture is active. Speak continuously and pause when you finish."}
                    </span>
                    {submitCountdownSec !== null && !submitting && (
                      <p className="text-xs text-amber-300">
                        Appending speech... sending in {submitCountdownSec}s after you stop.
                      </p>
                    )}
                  </div>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {loading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/90">
            <div className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-200">
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing AI interview...
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-x-0 bottom-4 z-50 mx-auto w-full max-w-2xl px-4">
            <Card className="border-red-500/40 bg-red-500/10">
              <CardContent className="flex items-center justify-between gap-3 py-3 text-sm text-red-100">
                <span>{error}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    void hydrateSession(true)
                      .catch((refreshError) => {
                        setError(errorToMessage(refreshError));
                      })
                      .finally(() => setLoading(false));
                  }}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </main>
  );
}
