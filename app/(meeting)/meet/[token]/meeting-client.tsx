"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { Bot, ShieldAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";

type JoinBlockedReason = "TOO_EARLY" | "AFTER_END" | "MEETING_ENDED" | null;
type ViewerRole = "CANDIDATE" | "INTERVIEWER";

type MeetingClientProps = {
  meetingToken: string;
  meetingRoomId: string;
  roundTitle: string;
  roundDescription: string | null;
  slotStartAt: string;
  slotEndAt: string;
  roundOwnerEmail: string | null;
  viewerRole: ViewerRole;
  isOwner: boolean;
  canMarkCompleted: boolean;
  canJoin: boolean;
  joinBlockedReason: JoinBlockedReason;
  meetingStatus: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED";
  initialMessages: Array<unknown>;
  meetingEndedAt: string | null;
};

type JitsiApiInstance = {
  dispose: () => void;
  executeCommand: (command: string, ...args: unknown[]) => void;
  addEventListeners: (listeners: Record<string, (...args: unknown[]) => void>) => void;
};

type AiSuggestion = {
  id: string;
  kind: "SUMMARY" | "FOLLOW_UP" | "EVAL" | "QUESTION";
  severity: "GOOD" | "WARN" | "BAD" | "NEUTRAL" | "QUESTION";
  text: string;
  relatedToTurnId: string | null;
  createdAt: string;
};

type AiStatePayload = {
  aiEnabled?: boolean;
  provider?: string;
  summary?: string[];
  questionSuggestions?: Array<{ question: string; reason?: string }>;
  suggestions?: AiSuggestion[];
  settings?: {
    liveTranscribeEnabled?: boolean;
    dynamicQuestionsEnabled?: boolean;
  };
};

type TranscriptTurnItem = {
  speaker: "CANDIDATE" | "INTERVIEWER";
  speakerName: string;
  text: string;
  timestamp: string;
  id?: string;
};

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: Record<string, unknown>,
    ) => JitsiApiInstance;
  }
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function blockedReasonMessage(reason: JoinBlockedReason) {
  if (reason === "TOO_EARLY") {
    return "Your interview hasn't started yet. Please join at your scheduled time.";
  }

  if (reason === "AFTER_END") {
    return "This interview slot has ended. You can no longer join.";
  }

  if (reason === "MEETING_ENDED") {
    return "The meeting has been ended by the interviewer.";
  }

  return "You cannot join this meeting right now.";
}

function normalizeJitsiDomain(rawValue?: string) {
  const value = rawValue?.trim();
  if (!value) {
    // DO NOT fall back to meet.jit.si — this app uses a self-hosted local Jitsi.
    // If this throws, set NEXT_PUBLIC_JITSI_DOMAIN=<your-lan-ip>:8443 in your .env
    throw new Error(
      "NEXT_PUBLIC_JITSI_DOMAIN is not configured. " +
      "Set it to your local Jitsi server, e.g. 10.19.220.188:8443",
    );
  }

  return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function normalizeOptionalJitsiDomain(rawValue?: string) {
  const value = rawValue?.trim();
  if (!value) {
    return null;
  }

  return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function getDomainHost(domain: string) {
  const firstSlash = domain.indexOf("/");
  const trimmed = firstSlash >= 0 ? domain.slice(0, firstSlash) : domain;
  const [host] = trimmed.split(":");
  return host || trimmed;
}

function buildScriptCandidates(domain: string, browserHost?: string) {
  const candidates: Array<{ domain: string; url: string }> = [];
  const add = (candidateDomain: string, scheme: "http" | "https", portHint?: string) => {
    const sanitized = candidateDomain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    if (!sanitized) {
      return;
    }

    const domainWithPort =
      portHint && !sanitized.includes(":") ? `${sanitized}:${portHint}` : sanitized;
    const url = `${scheme}://${domainWithPort}/external_api.js`;
    if (candidates.some((item) => item.url === url)) {
      return;
    }

    candidates.push({ domain: domainWithPort, url });
  };

  add(domain, "https");
  add(domain, "http");

  const domainHost = getDomainHost(domain);
  if (domain.endsWith(":8443")) {
    add(domainHost, "http", "8000");
  }

  if (browserHost) {
    add(browserHost, "https", "8443");
    add(browserHost, "http", "8000");
  }

  return candidates;
}

function normalizeScriptHost(rawValue?: string) {
  const value = rawValue?.trim();
  if (!value) {
    // DO NOT fall back to meet.jit.si — load external_api.js from the local Jitsi.
    // If this throws, set NEXT_PUBLIC_JITSI_SCRIPT_HOST=<your-lan-ip>:8443 in your .env
    throw new Error(
      "NEXT_PUBLIC_JITSI_SCRIPT_HOST is not configured. " +
      "Set it to your local Jitsi server, e.g. 10.19.220.188:8443",
    );
  }

  return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function formatNameFromEmail(email: string) {
  const localPart = email.split("@")[0] ?? "";
  if (!localPart) {
    return "User";
  }

  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getSuggestionToneClasses(
  severity: "GOOD" | "WARN" | "BAD" | "NEUTRAL" | "QUESTION",
) {
  switch (severity) {
    case "GOOD":
      return "border-emerald-500/50 bg-emerald-500/10 text-emerald-100";
    case "WARN":
      return "border-amber-500/50 bg-amber-500/10 text-amber-100";
    case "BAD":
      return "border-rose-500/50 bg-rose-500/10 text-rose-100";
    case "QUESTION":
      return "border-sky-500/50 bg-sky-500/10 text-sky-100";
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-100";
  }
}

function mergeSuggestions(existing: AiSuggestion[], incoming: AiSuggestion[]) {
  if (incoming.length === 0) {
    return existing;
  }

  const merged = new Map<string, AiSuggestion>();
  for (const suggestion of existing) {
    merged.set(suggestion.id, suggestion);
  }
  for (const suggestion of incoming) {
    merged.set(suggestion.id, suggestion);
  }

  return Array.from(merged.values())
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-80);
}

function mergeTranscriptTurns(existing: TranscriptTurnItem[], incoming: TranscriptTurnItem) {
  const signature = incoming.id
    ? incoming.id
    : `${incoming.speaker}|${incoming.speakerName}|${incoming.timestamp}|${incoming.text}`;
  if (
    existing.some(
      (item) =>
        (item.id && incoming.id && item.id === incoming.id) ||
        `${item.speaker}|${item.speakerName}|${item.timestamp}|${item.text}` === signature,
    )
  ) {
    return existing;
  }

  return [...existing, incoming]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-80);
}

export function MeetingClient({
  meetingToken,
  meetingRoomId,
  roundTitle,
  slotStartAt,
  slotEndAt,
  viewerRole,
  isOwner,
  canMarkCompleted,
  canJoin,
  joinBlockedReason,
  meetingStatus,
  meetingEndedAt,
}: MeetingClientProps) {
  const router = useRouter();
  const { getToken, isLoaded: isAuthLoaded } = useAuth();
  const { user } = useUser();
  const jitsiContainerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<JitsiApiInstance | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const sentFinalSegmentIdsRef = useRef<Set<string>>(new Set());
  const lastInterimSentRef = useRef("");
  const interimEmitTimerRef = useRef<number | null>(null);
  const finalEmitTimerRef = useRef<number | null>(null);
  const pendingFinalTextRef = useRef("");
  const joinedReportedRef = useRef(false);
  const localParticipantIdRef = useRef<string | null>(null);
  const localIsModeratorRef = useRef(false);
  const pendingModeratorGrantIdsRef = useRef<Set<string>>(new Set());

  const [isLoading, setIsLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);
  const [meetingJoined, setMeetingJoined] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [meetingEnded, setMeetingEnded] = useState(
    meetingStatus === "COMPLETED" || Boolean(meetingEndedAt),
  );
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiProvider, setAiProvider] = useState<string>("google");
  const [aiSummary, setAiSummary] = useState<string[]>([]);
  const [aiQuestions, setAiQuestions] = useState<Array<{ question: string; reason?: string }>>([]);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [liveTranscribeEnabled, setLiveTranscribeEnabled] = useState(true);
  const [dynamicQuestionsEnabled, setDynamicQuestionsEnabled] = useState(true);
  const [candidateResponseDraft, setCandidateResponseDraft] = useState("");
  const [isSendingCandidateResponse, setIsSendingCandidateResponse] = useState(false);
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurnItem[]>([]);
  const [interimTurn, setInterimTurn] = useState<TranscriptTurnItem | null>(null);
  const [transcriptOverlayMinimized, setTranscriptOverlayMinimized] = useState(false);
  const [assistantOverlayMinimized, setAssistantOverlayMinimized] = useState(false);
  const lastForceToastAtRef = useRef(0);
  const transcriptionDebugEnabled = process.env.NEXT_PUBLIC_DEBUG_TRANSCRIPTION === "1";

  const showJoinErrorCard = !canJoin || meetingEnded;

  const primaryJitsiDomain = useMemo(
    () => normalizeJitsiDomain(process.env.NEXT_PUBLIC_JITSI_DOMAIN),
    [],
  );
  const jitsiScriptHost = useMemo(
    () => normalizeScriptHost(process.env.NEXT_PUBLIC_JITSI_SCRIPT_HOST),
    [],
  );
  const fallbackJitsiDomain = useMemo(
    () => normalizeOptionalJitsiDomain(process.env.NEXT_PUBLIC_JITSI_FALLBACK_DOMAIN),
    [],
  );
  const domainFallbackTarget = fallbackJitsiDomain;
  const [activeJitsiDomain, setActiveJitsiDomain] = useState(primaryJitsiDomain);

  const jitsiRoomName = useMemo(() => {
    const safeToken = meetingToken.replace(/[^a-zA-Z0-9_-]/g, "");
    return `fullinterview_${safeToken}`;
  }, [meetingToken]);

  const isInterviewer = viewerRole === "INTERVIEWER";
  const speakerRole: "INTERVIEWER" | "CANDIDATE" =
    viewerRole === "INTERVIEWER" ? "INTERVIEWER" : "CANDIDATE";
  const logTranscription = useCallback(
    (...args: unknown[]) => {
      if (!transcriptionDebugEnabled) {
        return;
      }
      console.log("[meeting-transcription]", ...args);
    },
    [transcriptionDebugEnabled],
  );
  const {
    supported: transcriptionSupported,
    listening: transcriptionListening,
    interimTranscript,
    finalSegments,
    start: startRecognition,
    stop: stopRecognition,
    reset: resetRecognition,
    lastError: transcriptionError,
  } = useSpeechRecognition({
    lang: "en-US",
    continuous: true,
    interimResults: true,
    autoRestart: true,
    debug: transcriptionDebugEnabled,
  });
  const latestCandidateTurn = useMemo(
    () => {
      const fromFinal = transcriptTurns
        .slice()
        .reverse()
        .find((turn) => turn.speaker === "CANDIDATE");
      if (fromFinal) {
        return fromFinal;
      }
      if (speakerRole === "CANDIDATE" && interimTranscript.trim()) {
        return {
          speaker: "CANDIDATE",
          speakerName: "Candidate",
          text: interimTranscript.trim(),
          timestamp: new Date().toISOString(),
        };
      }
      if (interimTurn?.speaker === "CANDIDATE") {
        return interimTurn;
      }
      return null;
    },
    [interimTranscript, interimTurn, speakerRole, transcriptTurns],
  );
  const candidateTranscriptFeed = useMemo(
    () => transcriptTurns.filter((turn) => turn.speaker === "CANDIDATE"),
    [transcriptTurns],
  );
  const displayName = useMemo(() => {
    const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
    if (fullName) {
      return fullName;
    }

    const primaryEmail = user?.primaryEmailAddress?.emailAddress?.trim().toLowerCase();
    if (primaryEmail) {
      return formatNameFromEmail(primaryEmail);
    }

    if (user?.username) {
      return user.username;
    }

    return viewerRole === "INTERVIEWER"
      ? isOwner
        ? "Owner Interviewer"
        : "Interviewer"
      : "Candidate";
  }, [isOwner, user?.firstName, user?.lastName, user?.primaryEmailAddress?.emailAddress, user?.username, viewerRole]);
  const localInterimTurn = useMemo(() => {
    const text = interimTranscript.trim();
    if (!text) {
      return null;
    }
    return {
      speaker: speakerRole,
      speakerName: displayName,
      text,
      timestamp: new Date().toISOString(),
    } as TranscriptTurnItem;
  }, [displayName, interimTranscript, speakerRole]);
  const displayInterimTurn = interimTurn ?? localInterimTurn;

  const flushPendingFinalTranscript = useCallback(() => {
    const text = pendingFinalTextRef.current.trim();
    pendingFinalTextRef.current = "";
    if (!text || !socketRef.current || !socketConnected || !aiEnabled || !liveTranscribeEnabled) {
      return;
    }

    const payload = {
      meetingRoomId,
      speaker: speakerRole,
      speakerName: displayName,
      text,
      timestamp: new Date().toISOString(),
      segmentId: `batch-${Date.now()}`,
      isFinal: true,
    };
    logTranscription("outbound final batch", payload);
    socketRef.current.emit("ai:transcript", payload);
  }, [
    aiEnabled,
    displayName,
    liveTranscribeEnabled,
    logTranscription,
    meetingRoomId,
    socketConnected,
    speakerRole,
  ]);

  useEffect(() => {
    sentFinalSegmentIdsRef.current.clear();
    lastInterimSentRef.current = "";
    if (interimEmitTimerRef.current !== null) {
      window.clearTimeout(interimEmitTimerRef.current);
      interimEmitTimerRef.current = null;
    }
    if (finalEmitTimerRef.current !== null) {
      window.clearTimeout(finalEmitTimerRef.current);
      finalEmitTimerRef.current = null;
    }
    pendingFinalTextRef.current = "";
    setTranscriptTurns([]);
    setInterimTurn(null);
    resetRecognition();
  }, [meetingRoomId, resetRecognition]);

  const ensureJitsiScript = useCallback(async () => {
    if (typeof window === "undefined") {
      return;
    }

    if (window.JitsiMeetExternalAPI) {
      return;
    }

    const scriptId = "jitsi-external-api-script";
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;

    if (existing) {
      existing.remove();
    }

    const browserHost =
      typeof window !== "undefined" ? window.location.hostname.trim().toLowerCase() : "";
    const candidates: Array<{ domain: string; url: string }> = [];
    const seenUrls = new Set<string>();
    const addCandidates = (domain: string) => {
      for (const candidate of buildScriptCandidates(domain, browserHost || undefined)) {
        if (seenUrls.has(candidate.url)) {
          continue;
        }
        seenUrls.add(candidate.url);
        candidates.push(candidate);
      }
    };

    // Script host only provides external_api.js; it must not override the meeting domain.
    addCandidates(jitsiScriptHost);
    addCandidates(activeJitsiDomain);
    let lastError = "Failed to load Jitsi external API script";

    for (const candidate of candidates) {
      const loaded = await new Promise<boolean>((resolve) => {
        const script = document.createElement("script");
        script.id = scriptId;
        script.src = candidate.url;
        script.async = true;
        script.onload = () => resolve(Boolean(window.JitsiMeetExternalAPI));
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      });

      if (loaded && window.JitsiMeetExternalAPI) {
        return;
      }

      lastError = `Failed to load Jitsi external API script from ${candidate.url}`;
      const current = document.getElementById(scriptId);
      if (current) {
        current.remove();
      }
    }

    throw new Error(
      `${lastError}. Tried: ${candidates.map((candidate) => candidate.url).join(", ")}`,
    );
  }, [activeJitsiDomain, jitsiScriptHost]);

  const extractParticipantId = useCallback((payload: unknown): string | null => {
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    if (!("id" in payload)) {
      return null;
    }
    const id = (payload as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id : null;
  }, []);

  const flushPendingModeratorGrants = useCallback(() => {
    if (!isInterviewer || !localIsModeratorRef.current || !apiRef.current) {
      return;
    }

    for (const participantId of Array.from(pendingModeratorGrantIdsRef.current)) {
      try {
        apiRef.current.executeCommand("grantModerator", participantId);
      } catch {
        // Ignore grant failures and retry on later role events.
      }
    }
  }, [isInterviewer]);

  const switchToFallbackDomain = useCallback(() => {
    if (!domainFallbackTarget || domainFallbackTarget === activeJitsiDomain) {
      return false;
    }

    toast.info(
      `Switching meeting domain to ${domainFallbackTarget} due to moderator-auth restrictions.`,
    );
    apiRef.current?.dispose();
    apiRef.current = null;
    setLoadTimedOut(false);
    setConnectionError(null);
    setActiveJitsiDomain(domainFallbackTarget);
    return true;
  }, [activeJitsiDomain, domainFallbackTarget]);

  const reportJoin = useCallback(async () => {
    if (joinedReportedRef.current) {
      return;
    }

    joinedReportedRef.current = true;

    const response = await fetch(`/api/meetings/${meetingRoomId}/join`, {
      method: "POST",
    });

    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
    };

    if (!response.ok || !payload.ok) {
      joinedReportedRef.current = false;
      const message = payload.error ?? "Unable to join meeting";
      toast.error(message);

      if (response.status === 409) {
        setMeetingEnded(true);
        apiRef.current?.executeCommand("hangup");
      }
    }
  }, [meetingRoomId]);

  const markMeetingCompleted = useCallback(async () => {
    if (!canMarkCompleted) {
      toast.error("You do not have permission to mark this meeting as completed");
      return;
    }

    const response = await fetch(`/api/meetings/${meetingRoomId}/complete`, {
      method: "POST",
    });

    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      data?: { alreadyCompleted?: boolean };
    };

    if (!response.ok || !payload.ok) {
      toast.error(payload.error ?? "Unable to mark meeting as completed");
      return;
    }

    setMeetingEnded(true);
    toast.success(
      payload.data?.alreadyCompleted
        ? "Meeting was already completed"
        : "Meeting marked as completed",
    );
    apiRef.current?.executeCommand("hangup");
  }, [canMarkCompleted, meetingRoomId]);

  const toggleAiForMeeting = useCallback(() => {
    if (!isInterviewer) {
      return;
    }

    if (!isOwner) {
      toast.error("Only the owner can enable or disable AI.");
      return;
    }

    if (!socketRef.current) {
      toast.error("AI session is not connected yet.");
      return;
    }

    socketRef.current.emit("ai:toggle", { aiEnabled: !aiEnabled });
  }, [aiEnabled, isInterviewer, isOwner]);

  const emitAiSettings = useCallback(
    (settings: { liveTranscribeEnabled?: boolean; dynamicQuestionsEnabled?: boolean }) => {
      if (!socketRef.current) {
        toast.error("AI session is not connected yet.");
        return;
      }
      socketRef.current.emit("ai:settings:update", settings);
    },
    [],
  );

  const stopLocalTranscription = useCallback(() => {
    stopRecognition();
  }, [stopRecognition]);

  const startLocalTranscription = useCallback(async (options?: { silent?: boolean }) => {
    if (!aiEnabled || !liveTranscribeEnabled) {
      if (!options?.silent) {
        toast.info("Enable AI and live transcription first.");
      }
      return;
    }

    if (!socketRef.current || !socketConnected) {
      if (!options?.silent) {
        toast.error("Transcription channel is not connected yet.");
      }
      return;
    }

    if (!transcriptionSupported) {
      if (!options?.silent) {
        toast.error("Speech recognition is not supported in this browser (use Chrome).");
      }
      return;
    }

    const started = await startRecognition();
    if (!started && !options?.silent) {
      toast.error(
        transcriptionError === "not-allowed" || transcriptionError === "service-not-allowed"
          ? "Microphone permission denied for transcription."
          : "Unable to start transcription.",
      );
    }
  }, [
    aiEnabled,
    liveTranscribeEnabled,
    socketConnected,
    startRecognition,
    transcriptionError,
    transcriptionSupported,
  ]);

  const submitCandidateResponse = useCallback(async () => {
    const text = candidateResponseDraft.trim();
    if (!text) {
      return;
    }

    if (!socketRef.current) {
      toast.error("AI session is not connected yet.");
      return;
    }

    setIsSendingCandidateResponse(true);
    try {
      socketRef.current.emit("ai:transcript", {
        meetingRoomId,
        speaker: "CANDIDATE",
        speakerName: "Candidate",
        text,
        timestamp: new Date().toISOString(),
        isFinal: true,
      });
      setCandidateResponseDraft("");
      toast.success("Candidate response sent for live AI analysis.");
    } finally {
      setIsSendingCandidateResponse(false);
    }
  }, [candidateResponseDraft, meetingRoomId]);

  useEffect(() => {
    if (showJoinErrorCard) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setConnectionError(null);

    const setup = async () => {
      try {
        await ensureJitsiScript();

        if (
          cancelled ||
          !window.JitsiMeetExternalAPI ||
          !jitsiContainerRef.current ||
          apiRef.current
        ) {
          return;
        }

        const api = new window.JitsiMeetExternalAPI(activeJitsiDomain, {
          roomName: jitsiRoomName,
          parentNode: jitsiContainerRef.current,
          width: "100%",
          height: "100%",
          userInfo: {
            displayName,
          },
          configOverwrite: {
            prejoinPageEnabled: false,
            disableDeepLinking: true,
            enableWelcomePage: false,
            enableUserRolesBasedOnToken: false,
            enableLobby: false,
            startWithAudioMuted: false,
            startWithVideoMuted: false,
            disableModeratorIndicator: false,
            disableThirdPartyRequests: true,
            analytics: {
              disabled: true,
            },
          },
          interfaceConfigOverwrite: {
            SHOW_JITSI_WATERMARK: false,
            SHOW_BRAND_WATERMARK: false,
            TOOLBAR_BUTTONS:
              viewerRole === "INTERVIEWER"
                ? [
                  "microphone",
                  "camera",
                  "desktop",
                  "chat",
                  "participants-pane",
                  "tileview",
                  "fullscreen",
                  "hangup",
                  "settings",
                ]
                : [
                  "desktop",
                  "chat",
                  "participants-pane",
                  "tileview",
                  "fullscreen",
                  "hangup",
                  "settings",
                ],
          },
        });

        apiRef.current = api;

        api.addEventListeners({
          videoConferenceJoined: (payload: unknown) => {
            localParticipantIdRef.current = extractParticipantId(payload);
            pendingModeratorGrantIdsRef.current.clear();
            setMeetingJoined(true);
            setIsLoading(false);
            setLoadTimedOut(false);
            void reportJoin();
            if (viewerRole === "CANDIDATE") {
              api.executeCommand("toggleAudio");
              api.executeCommand("toggleAudio");
              api.executeCommand("toggleVideo");
              api.executeCommand("toggleVideo");
              api.executeCommand("toggleShareScreen");
            }
          },
          videoConferenceLeft: () => {
            setMeetingJoined(false);
            router.push(viewerRole === "CANDIDATE" ? "/dashboard" : "/interviewer");
          },
          readyToClose: () => {
            setMeetingJoined(false);
            router.push(viewerRole === "CANDIDATE" ? "/dashboard" : "/interviewer");
          },
          audioMuteStatusChanged: (payload: unknown) => {
            const muted =
              typeof payload === "object" &&
              payload !== null &&
              "muted" in payload &&
              Boolean((payload as { muted?: boolean }).muted);
            if (viewerRole !== "CANDIDATE" || !muted) {
              return;
            }
            api.executeCommand("toggleAudio");
            const now = Date.now();
            if (now - lastForceToastAtRef.current > 4000) {
              lastForceToastAtRef.current = now;
              toast.info("Microphone must remain ON for this interview.");
            }
          },
          videoMuteStatusChanged: (payload: unknown) => {
            const muted =
              typeof payload === "object" &&
              payload !== null &&
              "muted" in payload &&
              Boolean((payload as { muted?: boolean }).muted);
            if (viewerRole !== "CANDIDATE" || !muted) {
              return;
            }
            api.executeCommand("toggleVideo");
            const now = Date.now();
            if (now - lastForceToastAtRef.current > 4000) {
              lastForceToastAtRef.current = now;
              toast.info("Camera must remain ON for this interview.");
            }
          },
          screenSharingStatusChanged: (payload: unknown) => {
            const on =
              typeof payload === "object" &&
              payload !== null &&
              "on" in payload &&
              Boolean((payload as { on?: boolean }).on);
            if (viewerRole !== "CANDIDATE" || on) {
              return;
            }
            api.executeCommand("toggleShareScreen");
            const now = Date.now();
            if (now - lastForceToastAtRef.current > 4000) {
              lastForceToastAtRef.current = now;
              toast.info("Screen sharing is mandatory for candidates.");
            }
          },
          participantJoined: (payload: unknown) => {
            if (!isInterviewer) {
              return;
            }
            const participantId = extractParticipantId(payload);
            if (!participantId || participantId === localParticipantIdRef.current) {
              return;
            }
            pendingModeratorGrantIdsRef.current.add(participantId);
            flushPendingModeratorGrants();
          },
          participantRoleChanged: (payload: unknown) => {
            const participantId = extractParticipantId(payload);
            const role =
              typeof payload === "object" &&
                payload !== null &&
                "role" in payload &&
                typeof (payload as { role?: unknown }).role === "string"
                ? (payload as { role: string }).role
                : "";

            if (!participantId) {
              return;
            }

            if (participantId === localParticipantIdRef.current) {
              localIsModeratorRef.current = role.toLowerCase() === "moderator";
              flushPendingModeratorGrants();
              return;
            }

            if (role.toLowerCase() === "moderator") {
              pendingModeratorGrantIdsRef.current.delete(participantId);
            }
          },
          errorOccurred: (payload: unknown) => {
            const details =
              typeof payload === "object" && payload !== null
                ? JSON.stringify(payload).toLowerCase()
                : "";
            if (!details) {
              return;
            }

            const authRelated =
              details.includes("authenticationrequired") ||
              details.includes("authentication") ||
              details.includes("moderator") ||
              details.includes("lobby");

            if (!authRelated) {
              return;
            }

            if (!switchToFallbackDomain()) {
              setConnectionError(
                "This Jitsi domain requires moderator login. Configure NEXT_PUBLIC_JITSI_FALLBACK_DOMAIN to an anonymous-enabled domain.",
              );
              toast.error(
                "This Jitsi domain requires moderator login. Configure NEXT_PUBLIC_JITSI_FALLBACK_DOMAIN to an anonymous-enabled domain.",
              );
              setIsLoading(false);
            }
          },
        });
      } catch (error) {
        setIsLoading(false);
        toast.error(error instanceof Error ? error.message : "Unable to initialize Jitsi meeting");
      }
    };

    void setup();

    return () => {
      cancelled = true;
      setMeetingJoined(false);
      localParticipantIdRef.current = null;
      localIsModeratorRef.current = false;
      pendingModeratorGrantIdsRef.current.clear();
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, [
    ensureJitsiScript,
    extractParticipantId,
    flushPendingModeratorGrants,
    displayName,
    activeJitsiDomain,
    jitsiRoomName,
    isInterviewer,
    reportJoin,
    router,
    showJoinErrorCard,
    switchToFallbackDomain,
    viewerRole,
  ]);

  useEffect(() => {
    if (!isLoading) {
      setLoadTimedOut(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setLoadTimedOut(true);
    }, 12000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isLoading]);

  useEffect(() => {
    if (!loadTimedOut) {
      return;
    }

    if (switchToFallbackDomain()) {
      return;
    }

    setConnectionError(
      `Unable to connect to Jitsi at https://${activeJitsiDomain}. Open this URL directly and accept the HTTPS certificate warning, then retry.`,
    );
    toast.error(
      `Unable to connect to Jitsi at https://${activeJitsiDomain}. Open it once directly, trust the certificate, then retry.`,
    );
    setIsLoading(false);
  }, [activeJitsiDomain, loadTimedOut, switchToFallbackDomain]);

  useEffect(() => {
    if (!aiPanelOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAiPanelOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [aiPanelOpen]);

  useEffect(() => {
    if (aiEnabled && liveTranscribeEnabled) {
      return;
    }
    stopLocalTranscription();
  }, [aiEnabled, liveTranscribeEnabled, stopLocalTranscription]);

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }

    if (showJoinErrorCard || meetingEnded) {
      return;
    }

    let cancelled = false;
    setAiLoading(true);
    setAiError(null);

    const setupSocket = async () => {
      try {
        await fetch("/api/socket", { method: "GET", cache: "no-store" });

        let sessionToken: string | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          sessionToken = await getToken();
          if (sessionToken) {
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        if (!sessionToken) {
          setAiError("Unable to authenticate AI session for this meeting.");
          setAiLoading(false);
          return;
        }

        if (cancelled) {
          return;
        }

        const socket = io({
          path: "/api/socket_io",
          transports: ["websocket", "polling"],
          auth: {
            sessionToken,
            meetingToken,
          },
        });

        socketRef.current = socket;

        socket.on("connect", () => {
          if (cancelled) {
            return;
          }
          logTranscription("socket connected", { meetingToken, socketId: socket.id });
          setSocketConnected(true);
          socket.emit("join-room");
          if (isInterviewer) {
            socket.emit("ai:subscribe");
          }
        });

        socket.on("disconnect", () => {
          logTranscription("socket disconnected", { meetingToken });
          setSocketConnected(false);
        });

        socket.on("ai:state", (payload: AiStatePayload) => {
          if (typeof payload.aiEnabled === "boolean") {
            setAiEnabled(payload.aiEnabled);
          }
          if (typeof payload.settings?.liveTranscribeEnabled === "boolean") {
            setLiveTranscribeEnabled(payload.settings.liveTranscribeEnabled);
          }
          if (typeof payload.settings?.dynamicQuestionsEnabled === "boolean") {
            setDynamicQuestionsEnabled(payload.settings.dynamicQuestionsEnabled);
          }
          setAiProvider(payload.provider ?? "google");
          setAiSummary(Array.isArray(payload.summary) ? payload.summary : []);
          setAiQuestions(
            Array.isArray(payload.questionSuggestions) ? payload.questionSuggestions : [],
          );
          setAiSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
          setAiLoading(false);
          setAiError(null);
        });

        socket.on("ai:resume_summary", (payload: { bullets?: string[] }) => {
          if (!Array.isArray(payload?.bullets)) {
            return;
          }
          setAiSummary(payload.bullets);
        });

        socket.on(
          "ai:question_suggestions",
          (payload: { questions?: Array<{ question: string; reason?: string }> }) => {
            if (!Array.isArray(payload?.questions)) {
              return;
            }
            setAiQuestions(payload.questions);
          },
        );

        socket.on("ai:suggestion", (payload: AiSuggestion) => {
          if (!payload?.id) {
            return;
          }
          setAiSuggestions((prev) => mergeSuggestions(prev, [payload]));
        });

        socket.on(
          "transcript:append",
          (payload: {
            id?: string;
            speakerRole?: "CANDIDATE" | "INTERVIEWER";
            speakerName?: string;
            text?: string;
            timestamp?: string;
          }) => {
            const speaker = payload?.speakerRole;
            if (speaker !== "CANDIDATE" && speaker !== "INTERVIEWER") {
              return;
            }

            const text = payload.text?.trim();
            if (!text) {
              return;
            }

            logTranscription("inbound final", payload);
            const speakerName =
              payload.speakerName?.trim() ||
              (speaker === "INTERVIEWER" ? "Interviewer" : "Candidate");

            setTranscriptTurns((prev) =>
              mergeTranscriptTurns(prev, {
                id: payload.id,
                speaker,
                speakerName,
                text,
                timestamp: payload.timestamp ?? new Date().toISOString(),
              }),
            );
            setInterimTurn((prev) => (prev?.speaker === speaker ? null : prev));
          },
        );

        socket.on(
          "transcript:interim",
          (payload: {
            speakerRole?: "CANDIDATE" | "INTERVIEWER";
            speakerName?: string;
            text?: string;
            timestamp?: string;
          }) => {
            const speaker = payload?.speakerRole;
            if (speaker !== "CANDIDATE" && speaker !== "INTERVIEWER") {
              return;
            }

            const text = payload.text?.trim();
            if (!text) {
              return;
            }

            logTranscription("inbound interim", payload);
            setInterimTurn({
              speaker,
              speakerName:
                payload.speakerName?.trim() ||
                (speaker === "INTERVIEWER" ? "Interviewer" : "Candidate"),
              text,
              timestamp: payload.timestamp ?? new Date().toISOString(),
            });
          },
        );

        socket.on("ai:toggle", (payload: { aiEnabled?: boolean }) => {
          if (typeof payload.aiEnabled !== "boolean") {
            return;
          }
          setAiEnabled(payload.aiEnabled);
        });

        socket.on("ai:public-toggle", (payload: { aiEnabled?: boolean }) => {
          if (typeof payload.aiEnabled !== "boolean") {
            return;
          }
          setAiEnabled(payload.aiEnabled);
        });

        socket.on(
          "ai:public-settings",
          (payload: { liveTranscribeEnabled?: boolean; dynamicQuestionsEnabled?: boolean }) => {
            if (typeof payload.liveTranscribeEnabled === "boolean") {
              setLiveTranscribeEnabled(payload.liveTranscribeEnabled);
            }
            if (typeof payload.dynamicQuestionsEnabled === "boolean") {
              setDynamicQuestionsEnabled(payload.dynamicQuestionsEnabled);
            }
          },
        );

        socket.on(
          "ai:settings",
          (payload: { liveTranscribeEnabled?: boolean; dynamicQuestionsEnabled?: boolean }) => {
            if (typeof payload.liveTranscribeEnabled === "boolean") {
              setLiveTranscribeEnabled(payload.liveTranscribeEnabled);
            }
            if (typeof payload.dynamicQuestionsEnabled === "boolean") {
              setDynamicQuestionsEnabled(payload.dynamicQuestionsEnabled);
            }
          },
        );

        socket.on("ai:error", (payload: { message?: string }) => {
          const message = payload?.message ?? "AI service is temporarily unavailable.";
          setAiError(message);
          setAiLoading(false);
        });

        socket.on("connect_error", (error) => {
          setAiError(error?.message ?? "Unable to connect to AI service.");
          setAiLoading(false);
        });
      } catch (error) {
        setAiError(
          error instanceof Error ? error.message : "Unable to initialize AI for this meeting.",
        );
        setAiLoading(false);
      }
    };

    void setupSocket();

    return () => {
      cancelled = true;
      setSocketConnected(false);
      flushPendingFinalTranscript();
      stopLocalTranscription();
      if (socketRef.current) {
        socketRef.current.emit("leave-room");
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [
    getToken,
    isAuthLoaded,
    isInterviewer,
    meetingEnded,
    meetingToken,
    flushPendingFinalTranscript,
    logTranscription,
    showJoinErrorCard,
    stopLocalTranscription,
  ]);

  useEffect(() => {
    if (!socketRef.current || !socketConnected || !aiEnabled || !liveTranscribeEnabled) {
      return;
    }

    let hasNewFinalChunk = false;

    for (const segment of finalSegments) {
      if (sentFinalSegmentIdsRef.current.has(segment.id)) {
        continue;
      }

      sentFinalSegmentIdsRef.current.add(segment.id);
      pendingFinalTextRef.current = `${pendingFinalTextRef.current} ${segment.text}`.trim();
      hasNewFinalChunk = true;
    }

    if (!hasNewFinalChunk) {
      return;
    }

    if (finalEmitTimerRef.current !== null) {
      window.clearTimeout(finalEmitTimerRef.current);
    }

    finalEmitTimerRef.current = window.setTimeout(() => {
      flushPendingFinalTranscript();
      finalEmitTimerRef.current = null;
    }, 1200);

    return () => {
      if (finalEmitTimerRef.current !== null) {
        window.clearTimeout(finalEmitTimerRef.current);
        finalEmitTimerRef.current = null;
      }
    };
  }, [
    aiEnabled,
    finalSegments,
    flushPendingFinalTranscript,
    liveTranscribeEnabled,
    socketConnected,
  ]);

  useEffect(() => {
    if (!socketRef.current || !socketConnected || !aiEnabled || !liveTranscribeEnabled) {
      return;
    }

    const text = interimTranscript.trim();
    if (!text || text === lastInterimSentRef.current) {
      return;
    }

    if (interimEmitTimerRef.current !== null) {
      window.clearTimeout(interimEmitTimerRef.current);
      interimEmitTimerRef.current = null;
    }

    interimEmitTimerRef.current = window.setTimeout(() => {
      const payload = {
        meetingRoomId,
        speaker: speakerRole,
        speakerName: displayName,
        text,
        timestamp: new Date().toISOString(),
        isFinal: false,
      };
      logTranscription("outbound interim", payload);
      socketRef.current?.emit("ai:transcript", payload);
      lastInterimSentRef.current = text;
    }, 220);

    return () => {
      if (interimEmitTimerRef.current !== null) {
        window.clearTimeout(interimEmitTimerRef.current);
        interimEmitTimerRef.current = null;
      }
    };
  }, [
    aiEnabled,
    displayName,
    interimTranscript,
    liveTranscribeEnabled,
    logTranscription,
    meetingRoomId,
    socketConnected,
    speakerRole,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || isLoading || !connectionError) {
      return;
    }

    if (!connectionError.startsWith("Unable to connect to Jitsi at https://")) {
      return;
    }

    const markerKey = `jitsi-cert-redirected:${activeJitsiDomain}`;
    if (window.sessionStorage.getItem(markerKey) === "1") {
      return;
    }

    window.sessionStorage.setItem(markerKey, "1");
    toast.info(`Redirecting to https://${activeJitsiDomain} to trust the Jitsi certificate...`);

    const redirectTimer = window.setTimeout(() => {
      window.location.assign(`https://${activeJitsiDomain}`);
    }, 900);

    return () => {
      window.clearTimeout(redirectTimer);
    };
  }, [activeJitsiDomain, connectionError, isLoading]);

  useEffect(() => {
    const shouldAutoCapture =
      socketConnected &&
      meetingJoined &&
      aiEnabled &&
      liveTranscribeEnabled &&
      !showJoinErrorCard &&
      !meetingEnded;

    if (!shouldAutoCapture) {
      stopLocalTranscription();
      return;
    }

    if (transcriptionListening) {
      return;
    }

    void startLocalTranscription({ silent: true });
  }, [
    aiEnabled,
    liveTranscribeEnabled,
    meetingJoined,
    meetingEnded,
    showJoinErrorCard,
    socketConnected,
    startLocalTranscription,
    stopLocalTranscription,
    transcriptionListening,
  ]);

  useEffect(() => {
    const shouldAutoCapture =
      socketConnected &&
      meetingJoined &&
      aiEnabled &&
      liveTranscribeEnabled &&
      !showJoinErrorCard &&
      !meetingEnded;

    if (!shouldAutoCapture) {
      return;
    }

    const retryTimer = window.setInterval(() => {
      if (transcriptionListening) {
        return;
      }
      void startLocalTranscription({ silent: true });
    }, 3000);

    return () => {
      window.clearInterval(retryTimer);
    };
  }, [
    aiEnabled,
    liveTranscribeEnabled,
    meetingJoined,
    meetingEnded,
    showJoinErrorCard,
    socketConnected,
    startLocalTranscription,
    transcriptionListening,
  ]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const previousMeetingMode = document.body.dataset.meetingMode;
    document.body.dataset.meetingMode = "true";
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousMeetingMode) {
        document.body.dataset.meetingMode = previousMeetingMode;
      } else {
        delete document.body.dataset.meetingMode;
      }
    };
  }, []);

  if (showJoinErrorCard) {
    return (
      <main className="fixed inset-0 z-[80] flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-8 text-zinc-100">
        <Card className="w-full max-w-xl border-zinc-700 bg-zinc-900 text-zinc-100">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" />
              Unable to join meeting
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-zinc-300">
              {meetingEnded
                ? "This meeting has already ended."
                : blockedReasonMessage(joinBlockedReason)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => window.location.reload()}>
                Refresh
              </Button>
              <Button asChild variant="outline" className="border-zinc-600 text-zinc-100">
                <Link href={viewerRole === "CANDIDATE" ? "/dashboard" : "/interviewer"}>
                  Back to dashboard
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 z-[80] h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(59,130,246,0.16),transparent_40%),radial-gradient(circle_at_80%_75%,rgba(16,185,129,0.12),transparent_35%)]" />

      <div className="pointer-events-none absolute top-0 left-0 right-0 z-20 flex items-start justify-between gap-3 px-4 py-3">
        <div className="pointer-events-auto rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 backdrop-blur">
          <p className="text-sm font-medium">{roundTitle}</p>
          <p className="text-xs text-zinc-300">
            {formatDateTime(slotStartAt)} - {formatDateTime(slotEndAt)}
          </p>
        </div>
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 backdrop-blur">
          <Badge variant="outline" className="border-zinc-600 text-zinc-100">
            Jitsi IFrame API
          </Badge>
          <Badge variant={meetingEnded ? "secondary" : "default"}>
            {meetingEnded ? "COMPLETED" : meetingStatus}
          </Badge>
          <Badge variant={viewerRole === "INTERVIEWER" ? "default" : "secondary"}>
            {viewerRole}
          </Badge>
          {viewerRole === "CANDIDATE" && (
            <Badge variant={transcriptionListening ? "default" : "secondary"}>
              {transcriptionListening ? "Transcription ON" : "Transcription OFF"}
            </Badge>
          )}
          {isOwner && <Badge>Owner</Badge>}
          {viewerRole === "CANDIDATE" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-zinc-600 text-zinc-100"
              onClick={() =>
                transcriptionListening
                  ? stopLocalTranscription()
                  : void startLocalTranscription()
              }
              disabled={!transcriptionSupported || !aiEnabled || !liveTranscribeEnabled}
            >
              {transcriptionListening ? "Stop Transcription" : "Start Transcription"}
            </Button>
          )}
          {isInterviewer && (
            <Button
              type="button"
              size="sm"
              variant={aiPanelOpen ? "default" : "outline"}
              className={aiPanelOpen ? "" : "border-zinc-600 text-zinc-100"}
              onClick={() => setAiPanelOpen((prev) => !prev)}
            >
              <Sparkles className="mr-1.5 h-4 w-4" />
              AI Summarizer
            </Button>
          )}
          {isInterviewer && canMarkCompleted && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => void markMeetingCompleted()}
            >
              Mark Completed
            </Button>
          )}
        </div>
      </div>

      <div className="relative z-10 h-full w-full pt-16">
        <div className="h-full w-full border-y border-zinc-700 bg-black md:rounded-2xl md:border">
          <div ref={jitsiContainerRef} className="h-full w-full" />
        </div>
      </div>

      {!transcriptOverlayMinimized ? (
        <div className="pointer-events-auto absolute bottom-24 left-4 z-30 w-[min(420px,calc(100vw-1rem))]">
          <Card className="border-zinc-700 bg-zinc-900/85 text-zinc-100 backdrop-blur">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm">Live Interview Transcript</CardTitle>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-zinc-600 text-zinc-100"
                onClick={() => setTranscriptOverlayMinimized(true)}
              >
                Minimize
              </Button>
            </CardHeader>
            <CardContent className="pt-0">
              <ScrollArea className="max-h-44 pr-2">
                {transcriptTurns.length === 0 && !interimTurn ? (
                  <p className="text-xs text-zinc-400">Waiting for speech input...</p>
                ) : (
                  <div className="space-y-2">
                    {transcriptTurns.slice(-24).map((turn, index) => (
                      <div
                        key={`${turn.id ?? `${turn.speaker}-${turn.timestamp}-${index}`}`}
                        className="rounded bg-zinc-800/80 px-2 py-1.5"
                      >
                        <p className="text-[10px] text-zinc-400">
                          {turn.speakerName}: {new Date(turn.timestamp).toLocaleTimeString()}
                        </p>
                        <p className="text-xs text-zinc-100">{turn.text}</p>
                      </div>
                    ))}
                    {displayInterimTurn && (
                      <div className="rounded border border-dashed border-zinc-600 bg-zinc-900/80 px-2 py-1.5">
                        <p className="text-[10px] text-zinc-500">
                          {displayInterimTurn.speakerName} (live):{" "}
                          {new Date(displayInterimTurn.timestamp).toLocaleTimeString()}
                        </p>
                        <p className="text-xs italic text-zinc-300">{displayInterimTurn.text}</p>
                      </div>
                    )}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="pointer-events-auto absolute bottom-24 left-4 z-30">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-zinc-600 bg-zinc-900/85 text-zinc-100 backdrop-blur"
            onClick={() => setTranscriptOverlayMinimized(false)}
          >
            Show Transcript
          </Button>
        </div>
      )}

      {isInterviewer &&
        (!assistantOverlayMinimized ? (
          <div className="pointer-events-auto absolute bottom-24 right-4 z-30 w-[min(420px,calc(100vw-1rem))] max-md:bottom-[18.5rem] max-md:left-4 max-md:right-auto">
            <Card className="border-zinc-700 bg-zinc-900/85 text-zinc-100 backdrop-blur">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm">AI Interview Assistant</CardTitle>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-zinc-600 text-zinc-100"
                  onClick={() => setAssistantOverlayMinimized(true)}
                >
                  Minimize
                </Button>
              </CardHeader>
              <CardContent className="space-y-3 pt-0 text-xs">
                <div>
                  <p className="mb-1 font-semibold text-zinc-200">Live Candidate Transcript</p>
                  {candidateTranscriptFeed.length === 0 && !latestCandidateTurn ? (
                    <p className="text-zinc-400">Waiting for candidate speech input...</p>
                  ) : (
                    <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950/50 p-2">
                      {candidateTranscriptFeed.slice(-18).map((turn, index) => (
                        <div
                          key={`${turn.id ?? `${turn.timestamp}-${index}`}`}
                          className="rounded bg-zinc-900/70 px-2 py-1.5"
                        >
                          <p className="text-[10px] text-zinc-500">
                            {new Date(turn.timestamp).toLocaleTimeString()}
                          </p>
                          <p className="text-zinc-200">{turn.text}</p>
                        </div>
                      ))}
                      {latestCandidateTurn && (
                        <div className="rounded border border-dashed border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
                          <p className="text-[10px] text-amber-300">Candidate (live)</p>
                          <p className="text-amber-100">{latestCandidateTurn.text}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="pointer-events-auto absolute bottom-24 right-4 z-30 max-md:bottom-[18.5rem] max-md:left-4 max-md:right-auto">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-zinc-600 bg-zinc-900/85 text-zinc-100 backdrop-blur"
              onClick={() => setAssistantOverlayMinimized(false)}
            >
              Show AI Assistant
            </Button>
          </div>
        ))}

      {isInterviewer && aiPanelOpen && (
        <div className="absolute right-3 top-16 bottom-6 z-40 w-[min(420px,calc(100vw-24px))]">
          <Card className="flex h-full flex-col border-zinc-700 bg-zinc-900/95 text-zinc-100 backdrop-blur">
            <CardHeader className="space-y-3 pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Bot className="h-4 w-4" />
                  AI Summarizer
                </CardTitle>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-zinc-600 text-zinc-100"
                  onClick={() => setAiPanelOpen(false)}
                >
                  Close
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-zinc-600 text-zinc-100">
                  Provider: {aiProvider}
                </Badge>
                <Badge variant={aiEnabled ? "default" : "secondary"}>
                  {aiEnabled ? "AI ON" : "AI OFF"}
                </Badge>
                {isOwner && (
                  <Button
                    type="button"
                    size="sm"
                    variant={aiEnabled ? "destructive" : "default"}
                    onClick={toggleAiForMeeting}
                  >
                    {aiEnabled ? "Turn AI Off" : "Turn AI On"}
                  </Button>
                )}
              </div>
              {aiError && <p className="text-xs text-amber-200">{aiError}</p>}
            </CardHeader>
            <Separator className="bg-zinc-700" />
            <CardContent className="min-h-0 flex-1 p-0">
              <ScrollArea className="h-full px-4 py-3">
                <div className="space-y-5">
                  <section className="space-y-3">
                    <h3 className="text-sm font-semibold">Live settings</h3>
                    <div className="rounded-md border border-zinc-700 bg-zinc-800/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-zinc-100">Live auto transcribe</p>
                          <p className="text-[11px] text-zinc-400">
                            Shared across all interviewers in this meeting.
                          </p>
                        </div>
                        <Switch
                          checked={liveTranscribeEnabled}
                          onCheckedChange={(checked) =>
                            emitAiSettings({ liveTranscribeEnabled: Boolean(checked) })
                          }
                          disabled={!aiEnabled}
                        />
                      </div>

                      <Separator className="my-3 bg-zinc-700" />

                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-zinc-100">Dynamic questions</p>
                          <p className="text-[11px] text-zinc-400">
                            Generate follow-up questions from candidate responses.
                          </p>
                        </div>
                        <Switch
                          checked={dynamicQuestionsEnabled}
                          onCheckedChange={(checked) =>
                            emitAiSettings({ dynamicQuestionsEnabled: Boolean(checked) })
                          }
                          disabled={!aiEnabled || !liveTranscribeEnabled}
                        />
                      </div>
                    </div>

                    <div className="rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-2">
                      <p className="text-[11px] text-zinc-300">
                        Candidate speech is auto-captured on the candidate side when live transcribe
                        is enabled and streamed here for AI analysis.
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge variant={transcriptionListening ? "default" : "secondary"}>
                          {transcriptionListening
                            ? "Your mic transcription: ACTIVE"
                            : "Your mic transcription: RETRYING"}
                        </Badge>
                        {!transcriptionSupported && (
                          <Badge variant="destructive">Speech API unsupported</Badge>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="border-zinc-600 text-zinc-100"
                          onClick={() =>
                            transcriptionListening
                              ? stopLocalTranscription()
                              : void startLocalTranscription()
                          }
                          disabled={
                            !aiEnabled ||
                            !liveTranscribeEnabled ||
                            !transcriptionSupported
                          }
                        >
                          {transcriptionListening
                            ? "Stop transcription"
                            : "Start transcription"}
                        </Button>
                      </div>
                      {transcriptionError && (
                        <p className="mt-2 text-[11px] text-amber-300">
                          Transcription error: {transcriptionError}
                        </p>
                      )}
                      {transcriptTurns.length > 0 ? (
                        <div className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1">
                          {transcriptTurns.slice(-12).map((turn, index) => (
                            <div key={`${turn.speaker}-${turn.timestamp}-${index}`} className="rounded bg-zinc-900/80 px-2 py-1">
                              <p className="text-[10px] text-zinc-400">
                                {turn.speakerName} ·{" "}
                                {new Date(turn.timestamp).toLocaleTimeString()}
                              </p>
                              <p className="text-[11px] text-zinc-200">{turn.text}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] text-zinc-500">
                          Waiting for candidate speech input...
                        </p>
                      )}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Candidate response input (optional)</h3>
                    <p className="text-[11px] text-zinc-400">
                      Candidate speech is auto-captured when live transcribe is ON. Use this only as a fallback.
                    </p>
                    <Textarea
                      value={candidateResponseDraft}
                      onChange={(event) => setCandidateResponseDraft(event.target.value)}
                      placeholder="Type candidate response here..."
                      className="min-h-24 border-zinc-700 bg-zinc-900 text-zinc-100"
                      disabled={!aiEnabled || !liveTranscribeEnabled || !dynamicQuestionsEnabled}
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void submitCandidateResponse()}
                      disabled={
                        isSendingCandidateResponse ||
                        !candidateResponseDraft.trim() ||
                        !aiEnabled ||
                        !liveTranscribeEnabled ||
                        !dynamicQuestionsEnabled
                      }
                    >
                      {isSendingCandidateResponse ? "Sending..." : "Send candidate response"}
                    </Button>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Resume summary</h3>
                    {aiLoading && aiSummary.length === 0 ? (
                      <p className="text-xs text-zinc-400">Loading summary...</p>
                    ) : aiSummary.length === 0 ? (
                      <p className="text-xs text-zinc-400">Summary not available yet.</p>
                    ) : (
                      <ul className="space-y-2 text-xs text-zinc-200">
                        {aiSummary.map((line, index) => (
                          <li key={`${index}-${line}`} className="rounded-md bg-zinc-800/70 px-2 py-1.5">
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Suggested questions</h3>
                    {aiQuestions.length === 0 ? (
                      <p className="text-xs text-zinc-400">Question suggestions will appear here.</p>
                    ) : (
                      <ul className="space-y-2">
                        {aiQuestions.map((question, index) => (
                          <li key={`${question.question}-${index}`} className="rounded-md border border-zinc-700 bg-zinc-800/70 p-2">
                            <p className="text-xs font-medium text-zinc-100">{question.question}</p>
                            {question.reason ? (
                              <p className="mt-1 text-[11px] text-zinc-400">{question.reason}</p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Live hints</h3>
                    {aiSuggestions.length === 0 ? (
                      <p className="text-xs text-zinc-400">Live AI hints will appear during the interview.</p>
                    ) : (
                      <ul className="space-y-2">
                        {aiSuggestions.map((suggestion) => (
                          <li
                            key={suggestion.id}
                            className={`rounded-md border px-2 py-1.5 text-xs ${getSuggestionToneClasses(suggestion.severity)}`}
                          >
                            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide opacity-90">
                              <span>{suggestion.kind.replace("_", " ")}</span>
                              <span>{new Date(suggestion.createdAt).toLocaleTimeString()}</span>
                            </div>
                            <p>{suggestion.text}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-zinc-950/80">
          <div className="max-w-lg space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm">
            <p>Loading Jitsi meeting...</p>
            {loadTimedOut && (
              <p className="text-xs text-amber-200">
                {activeJitsiDomain === "meet.jit.si"
                  ? fallbackJitsiDomain && fallbackJitsiDomain !== "meet.jit.si"
                    ? `meet.jit.si requires moderator auth for this room. Falling back to ${fallbackJitsiDomain}.`
                    : "meet.jit.si may require moderator login on some rooms. For no-login moderator flow, use your own Jitsi server domain in NEXT_PUBLIC_JITSI_DOMAIN (or set NEXT_PUBLIC_JITSI_FALLBACK_DOMAIN)."
                  : `Meeting bootstrap is taking longer than expected. Open https://${activeJitsiDomain} in a new tab and trust the certificate, then retry.`}
              </p>
            )}
          </div>
        </div>
      )}

      {connectionError && !isLoading && (
        <div className="absolute left-4 right-4 top-20 z-40 rounded-md border border-amber-400/60 bg-amber-500/15 px-3 py-3 text-xs text-amber-100 md:left-auto md:max-w-2xl">
          <p>{connectionError}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="border-amber-300 text-amber-100">
              <a href={`https://${activeJitsiDomain}`} target="_blank" rel="noreferrer">
                Open Jitsi Host
              </a>
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        </div>
      )}

    </main>
  );
}
