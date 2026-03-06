import { createHash } from "crypto";
import { z } from "zod";

import type { ConversationContext, ConversationTurn, ProctoringSignal } from "@/lib/ai/provider";
import { getProvider } from "@/lib/ai/get-provider";
import { ensureLocalModelReady } from "@/lib/ai/local-model-readiness";
import { evaluateInterviewWithPenalty } from "@/lib/ai-interview/InterviewEvaluator";
import { joinMeetingRoom } from "@/lib/meeting-lifecycle";
import { resolveMeetingAccessByRoomId } from "@/lib/meetingAccess";
import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const MAX_QUESTIONS = 6;
const MAX_INTERVIEW_MINUTES = 10;
const QUESTION_PLAN_TIMEOUT_MS = 12_000;
const CLOSING_MESSAGE =
  "Thank you for completing the interview. Your responses will now be evaluated. We appreciate your time. You may now exit the meeting.";

type PublicTurn = {
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
  transcript: PublicTurn[];
  nextQuestion: string | null;
  evaluation:
    | {
        aiScore: number;
        finalScore: number;
        summary: string;
        strengths: string[];
        weaknesses: string[];
        malpracticePenalty: number;
      }
    | null;
};

const proctoringEventSchema = z.object({
  type: z.enum(["LOOK_LEFT", "LOOK_RIGHT", "LOOK_DOWN", "MULTIPLE_WARNINGS"]),
  durationSec: z.number().int().min(1).max(120),
  timestamp: z.string().datetime(),
  hash: z.string().trim().min(12).max(200),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

class AiInterviewError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isMissingAiTablesError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2021"
  );
}

function isUniqueMeetingRoomSessionError(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: string }).code !== "P2002"
  ) {
    return false;
  }

  const target =
    "meta" in error &&
    typeof (error as { meta?: unknown }).meta === "object" &&
    (error as { meta?: { target?: unknown } }).meta?.target;

  if (!target) {
    return true;
  }

  if (Array.isArray(target)) {
    return target.includes("meetingRoomId");
  }

  return String(target).toLowerCase().includes("meetingroomid");
}

function toKnownAiInterviewError(error: unknown): never {
  if (error instanceof AiInterviewError) {
    throw error;
  }

  if (isMissingAiTablesError(error)) {
    throw new AiInterviewError(
      "AI interview tables are not available yet. Run Prisma migration and retry.",
      503,
    );
  }

  throw error;
}

function normalizeText(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase();
}

function toDisplayName(name: string | null, email: string | null) {
  if (name?.trim()) {
    return name.trim();
  }

  const localPart = (email ?? "").split("@")[0] ?? "Candidate";
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function greetingForCandidate(candidateName: string) {
  return [
    `Hello ${candidateName}.`,
    "Welcome to your AI interview session.",
    "Today I will be evaluating your skills based on your resume and responses.",
    "Please answer clearly.",
    "The interview will consist of around 6 questions including follow-ups.",
    "Let's begin.",
  ].join(" ");
}

function fallbackQuestions(): string[] {
  return [
    "Walk me through one backend project you are most proud of and your exact contribution.",
    "How do you approach debugging a production issue under time pressure?",
    "Explain a technical trade-off you made recently and why.",
    "How do you ensure reliability and scalability in your backend services?",
    "If we asked you to improve this system in the first 30 days, what would you do first?",
    "Describe a failure or incident you handled and the concrete lessons you applied afterward.",
  ];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function requireAiCandidateAccess(meetingRoomId: string, clerkUserId: string) {
  const access = await resolveMeetingAccessByRoomId(meetingRoomId, clerkUserId);

  if (!access.ok) {
    throw new AiInterviewError(access.message, access.status);
  }

  if (access.viewerRole !== "CANDIDATE") {
    throw new AiInterviewError("AI interview mode is available for candidates only", 403);
  }

  if (access.room.roundConductedBy !== "AI") {
    throw new AiInterviewError("This room is not configured for AI interview mode", 400);
  }

  return access;
}

function mapTurnsForConversation(turns: PublicTurn[]): ConversationTurn[] {
  return turns.map((turn) => ({
    speaker: turn.speaker === "AI" ? "INTERVIEWER" : "CANDIDATE",
    text: turn.text,
    timestamp: turn.timestamp,
  }));
}

function buildContextFromAccess(
  access: Awaited<ReturnType<typeof requireAiCandidateAccess>>,
  resume: unknown,
  turns: PublicTurn[],
  aiInterviewMeta?: ConversationContext["aiInterviewMeta"],
): ConversationContext {
  return {
    interview: {
      roundTitle: access.room.roundTitle,
      roundDescription: access.room.roundDescription,
      conductedBy: "AI",
      ownerEmail: access.room.roundOwnerEmail,
      candidateEmail: access.room.slotCandidateEmail,
      slotStartAt: access.room.slotStartAt.toISOString(),
      slotEndAt: access.room.slotEndAt.toISOString(),
    },
    resume: resume as ConversationContext["resume"],
    recentTurns: mapTurnsForConversation(turns).slice(-20),
    aiInterviewMeta,
  };
}

async function generateQuestionPlan(input: {
  access: Awaited<ReturnType<typeof requireAiCandidateAccess>>;
  parsedResume: unknown;
}) {
  const provider = getProvider();
  let suggested: Awaited<ReturnType<typeof provider.suggestQuestions>> | null = null;

  try {
    suggested = await withTimeout(
      provider.suggestQuestions(input.parsedResume as never, {
        roundTitle: input.access.room.roundTitle,
        roundDescription: input.access.room.roundDescription,
        conductedBy: "AI",
        ownerEmail: input.access.room.roundOwnerEmail,
        candidateEmail: input.access.room.slotCandidateEmail,
        slotStartAt: input.access.room.slotStartAt.toISOString(),
        slotEndAt: input.access.room.slotEndAt.toISOString(),
      }),
      QUESTION_PLAN_TIMEOUT_MS,
      "AI question planning",
    );
  } catch (error) {
    // Keep interview start responsive even if the LLM is slow/unavailable.
    console.error("[ai-interview] Question plan generation failed, using fallback questions", error);
  }

  const deduped = new Set<string>();
  const questions: string[] = [];

  if (suggested) {
    for (const item of suggested.questions) {
      const value = item.question.trim();
      if (!value) {
        continue;
      }
      const key = normalizeText(value);
      if (deduped.has(key)) {
        continue;
      }
      deduped.add(key);
      questions.push(value);
      if (questions.length >= MAX_QUESTIONS) {
        break;
      }
    }
  }

  for (const fallback of fallbackQuestions()) {
    if (questions.length >= MAX_QUESTIONS) {
      break;
    }
    const key = normalizeText(fallback);
    if (deduped.has(key)) {
      continue;
    }
    deduped.add(key);
    questions.push(fallback);
  }

  return questions.slice(0, MAX_QUESTIONS);
}

function toPublicTurns(
  turns: Array<{
    id: string;
    speaker: "AI" | "CANDIDATE";
    text: string;
    createdAt: Date;
    questionIdx: number | null;
    isFollowUp: boolean;
  }>,
): PublicTurn[] {
  return turns.map((turn) => ({
    id: turn.id,
    speaker: turn.speaker,
    text: turn.text,
    timestamp: turn.createdAt.toISOString(),
    questionIdx: turn.questionIdx,
    isFollowUp: turn.isFollowUp,
  }));
}

function getSessionState(input: {
  session: {
    id: string;
    status: "IN_PROGRESS" | "COMPLETED";
    questionPlan: unknown;
    aiScore: number | null;
    finalScore: number | null;
    summary: string | null;
    strengths: string[];
    weaknesses: string[];
    malpracticePenalty: number;
  };
  turns: PublicTurn[];
}) {
  const questionPlan =
    input.session.questionPlan &&
    typeof input.session.questionPlan === "object" &&
    input.session.questionPlan !== null &&
    Array.isArray((input.session.questionPlan as { questions?: unknown }).questions)
      ? ((input.session.questionPlan as { questions: unknown[] }).questions.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        ) as string[])
      : [];

  const askedQuestions = input.turns.filter((turn) => turn.speaker === "AI" && turn.questionIdx !== null)
    .length;
  const candidateResponses = input.turns.filter((turn) => turn.speaker === "CANDIDATE").length;
  const lastAiQuestion = [...input.turns]
    .reverse()
    .find((turn) => turn.speaker === "AI" && turn.questionIdx !== null);

  return {
    sessionId: input.session.id,
    status: input.session.status,
    maxQuestions: Math.max(questionPlan.length, MAX_QUESTIONS),
    askedQuestions,
    candidateResponses,
    transcript: input.turns,
    nextQuestion: input.session.status === "COMPLETED" ? null : (lastAiQuestion?.text ?? null),
    evaluation:
      input.session.status === "COMPLETED" &&
      input.session.aiScore !== null &&
      input.session.finalScore !== null &&
      input.session.summary
        ? {
            aiScore: input.session.aiScore,
            finalScore: input.session.finalScore,
            summary: input.session.summary,
            strengths: input.session.strengths,
            weaknesses: input.session.weaknesses,
            malpracticePenalty: input.session.malpracticePenalty,
          }
        : null,
  } satisfies SessionState;
}

async function ensureSession(meetingRoomId: string, clerkUserId: string) {
  const access = await requireAiCandidateAccess(meetingRoomId, clerkUserId);

  const parsedResume = await prisma.parsedResume.findUnique({
    where: {
      candidateUserId_roundId: {
        candidateUserId: access.user.id,
        roundId: access.room.roundId,
      },
    },
    select: {
      data: true,
    },
  });

  if (!parsedResume) {
    throw new AiInterviewError("Resume is required before starting AI interview", 400);
  }

  const existing = await prisma.aiInterviewSession.findUnique({
    where: { meetingRoomId: access.room.id },
    include: {
      transcriptTurns: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          speaker: true,
          text: true,
          createdAt: true,
          questionIdx: true,
          isFollowUp: true,
        },
      },
    },
  });

  if (existing) {
    return {
      access,
      parsedResume: parsedResume.data,
      session: existing,
      turns: toPublicTurns(existing.transcriptTurns),
    };
  }

  if (!access.canJoin || access.room.status === "COMPLETED") {
    throw new AiInterviewError("Meeting completed", 409);
  }

  try {
    await ensureLocalModelReady("ai-interview");
  } catch (error) {
    throw new AiInterviewError(
      error instanceof Error ? error.message : "Local model readiness check failed",
      503,
      "INTERVIEW_MODEL_NOT_READY",
    );
  }

  const questions = await generateQuestionPlan({
    access,
    parsedResume: parsedResume.data,
  });

  if (access.canJoin) {
    await joinMeetingRoom({
      meetingRoomId: access.room.id,
      clerkUserId,
    });
  }

  const candidateName = toDisplayName(access.user.name, access.user.email);
  const greeting = greetingForCandidate(candidateName);
  const openingQuestion = questions[0] ?? fallbackQuestions()[0];

  const createdSession = await prisma.aiInterviewSession.create({
    data: {
      meetingRoomId: access.room.id,
      roundId: access.room.roundId,
      candidateUserId: access.user.id,
      questionPlan: { questions },
      status: "IN_PROGRESS",
      transcriptTurns: {
        create: [
          {
            speaker: "AI",
            text: greeting,
            questionIdx: null,
            isFollowUp: false,
          },
          {
            speaker: "AI",
            text: openingQuestion,
            questionIdx: 1,
            isFollowUp: false,
          },
        ],
      },
    },
    include: {
      transcriptTurns: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          speaker: true,
          text: true,
          createdAt: true,
          questionIdx: true,
          isFollowUp: true,
        },
      },
    },
  }).catch(async (error) => {
    if (!isUniqueMeetingRoomSessionError(error)) {
      throw error;
    }

    const racedExisting = await prisma.aiInterviewSession.findUnique({
      where: { meetingRoomId: access.room.id },
      include: {
        transcriptTurns: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            speaker: true,
            text: true,
            createdAt: true,
            questionIdx: true,
            isFollowUp: true,
          },
        },
      },
    });

    if (!racedExisting) {
      throw error;
    }

    return racedExisting;
  });

  return {
    access,
    parsedResume: parsedResume.data,
    session: createdSession,
    turns: toPublicTurns(createdSession.transcriptTurns),
  };
}

function interviewTimedOut(startedAt: Date) {
  return Date.now() - startedAt.getTime() >= MAX_INTERVIEW_MINUTES * 60_000;
}

async function completeSession(input: {
  access: Awaited<ReturnType<typeof requireAiCandidateAccess>>;
  sessionId: string;
  parsedResume: unknown;
  clerkUserId: string;
}) {
  const [session, proctoringEventsRaw, turnsRaw] = await Promise.all([
    prisma.aiInterviewSession.findUnique({
      where: { id: input.sessionId },
      select: {
        id: true,
        status: true,
        startedAt: true,
      },
    }),
    prisma.aiProctoringEvent.findMany({
      where: { sessionId: input.sessionId },
      orderBy: { occurredAt: "asc" },
      select: {
        type: true,
        durationSec: true,
        occurredAt: true,
      },
    }),
    prisma.aiInterviewTurn.findMany({
      where: { sessionId: input.sessionId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        speaker: true,
        text: true,
        createdAt: true,
        questionIdx: true,
        isFollowUp: true,
      },
    }),
  ]);

  if (!session) {
    throw new AiInterviewError("AI interview session not found", 404);
  }

  if (session.status === "COMPLETED") {
    const completed = await prisma.aiInterviewSession.findUnique({
      where: { id: session.id },
      include: {
        transcriptTurns: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            speaker: true,
            text: true,
            createdAt: true,
            questionIdx: true,
            isFollowUp: true,
          },
        },
      },
    });

    if (!completed) {
      throw new AiInterviewError("AI interview session not found", 404);
    }

    return getSessionState({
      session: completed,
      turns: toPublicTurns(completed.transcriptTurns),
    });
  }

  const turns = toPublicTurns(turnsRaw);
  const conversationTurns = mapTurnsForConversation(turns);
  const proctoringSignals: ProctoringSignal[] = proctoringEventsRaw.map((event) => ({
    type: event.type,
    durationSec: event.durationSec,
    timestamp: event.occurredAt.toISOString(),
  }));

  const context = buildContextFromAccess(input.access, input.parsedResume, turns);
  const { evaluation, aiScore, finalScore, penalty } = await evaluateInterviewWithPenalty({
    context,
    transcript: conversationTurns,
    proctoringSignals,
  });

  const completedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.aiInterviewTurn.create({
      data: {
        sessionId: session.id,
        speaker: "AI",
        text: CLOSING_MESSAGE,
        questionIdx: null,
        isFollowUp: false,
      },
    });

    await tx.aiInterviewSession.update({
      where: { id: session.id },
      data: {
        status: "COMPLETED",
        completedAt,
        aiScore,
        finalScore,
        summary: evaluation.summary,
        strengths: evaluation.strengths,
        weaknesses: evaluation.weaknesses,
        malpracticePenalty: penalty,
      },
    });

    await tx.meetingRoom.updateMany({
      where: {
        id: input.access.room.id,
        status: { not: "COMPLETED" },
      },
      data: {
        status: "COMPLETED",
        completedAt,
        completedByUserId: input.access.user.id,
        endedAt: completedAt,
        endedByUserId: input.access.user.id,
      },
    });

    await tx.meetingParticipant.updateMany({
      where: {
        meetingRoomId: input.access.room.id,
        leftAt: null,
      },
      data: {
        leftAt: completedAt,
      },
    });

    await tx.meetingAiSession.updateMany({
      where: {
        meetingRoomId: input.access.room.id,
        endedAt: null,
      },
      data: {
        endedAt: completedAt,
        aiEnabled: false,
      },
    });
  });

  const completedSession = await prisma.aiInterviewSession.findUnique({
    where: { id: session.id },
    include: {
      transcriptTurns: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          speaker: true,
          text: true,
          createdAt: true,
          questionIdx: true,
          isFollowUp: true,
        },
      },
    },
  });

  if (!completedSession) {
    throw new AiInterviewError("AI interview session not found", 404);
  }

  return getSessionState({
    session: completedSession,
    turns: toPublicTurns(completedSession.transcriptTurns),
  });
}

function tryPickDynamicQuestion(input: {
  suggestions: Array<{ kind: string; text: string }>;
  askedTexts: Set<string>;
}) {
  const preferred = input.suggestions.find(
    (suggestion) =>
      (suggestion.kind === "FOLLOW_UP" || suggestion.kind === "QUESTION") &&
      !input.askedTexts.has(normalizeText(suggestion.text)),
  );

  return preferred?.text?.trim() || null;
}

export async function initializeAiInterviewSession(input: {
  meetingRoomId: string;
  clerkUserId: string;
}): Promise<SessionState> {
  try {
    const data = await ensureSession(input.meetingRoomId, input.clerkUserId);
    return getSessionState({
      session: data.session,
      turns: data.turns,
    });
  } catch (error) {
    toKnownAiInterviewError(error);
  }
}

export async function submitAiCandidateAnswer(input: {
  meetingRoomId: string;
  clerkUserId: string;
  answerText: string;
}): Promise<SessionState> {
  try {
    const answerText = input.answerText.trim();
    if (!answerText) {
      throw new AiInterviewError("Candidate response is required", 400);
    }

    const ensured = await ensureSession(input.meetingRoomId, input.clerkUserId);

    if (ensured.session.status === "COMPLETED") {
      return getSessionState({
        session: ensured.session,
        turns: ensured.turns,
      });
    }

    if (interviewTimedOut(ensured.session.startedAt)) {
      return completeSession({
        access: ensured.access,
        sessionId: ensured.session.id,
        parsedResume: ensured.parsedResume,
        clerkUserId: input.clerkUserId,
      });
    }

    const storedCandidateTurn = await prisma.aiInterviewTurn.create({
      data: {
        sessionId: ensured.session.id,
        speaker: "CANDIDATE",
        text: answerText,
        questionIdx: null,
        isFollowUp: false,
      },
      select: {
        id: true,
        speaker: true,
        text: true,
        createdAt: true,
        questionIdx: true,
        isFollowUp: true,
      },
    });

    const turnsAfterCandidate = [...ensured.turns, ...toPublicTurns([storedCandidateTurn])];
    const askedQuestions = turnsAfterCandidate.filter(
      (turn) => turn.speaker === "AI" && turn.questionIdx !== null,
    ).length;
    const candidateResponses = turnsAfterCandidate.filter(
      (turn) => turn.speaker === "CANDIDATE",
    ).length;

    if (candidateResponses >= MAX_QUESTIONS || askedQuestions >= MAX_QUESTIONS) {
      return completeSession({
        access: ensured.access,
        sessionId: ensured.session.id,
        parsedResume: ensured.parsedResume,
        clerkUserId: input.clerkUserId,
      });
    }

    const questionPlan =
      ensured.session.questionPlan &&
      typeof ensured.session.questionPlan === "object" &&
      ensured.session.questionPlan !== null &&
      Array.isArray((ensured.session.questionPlan as { questions?: unknown }).questions)
        ? ((ensured.session.questionPlan as { questions: unknown[] }).questions.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
          ) as string[])
        : fallbackQuestions();

    const conversationContext = buildContextFromAccess(
      ensured.access,
      ensured.parsedResume,
      turnsAfterCandidate,
      {
        maxQuestions: MAX_QUESTIONS,
        currentQuestionCount: askedQuestions,
        interviewMode: "voice",
        browserWillReadAloud: true,
      },
    );

    const provider = getProvider();
    const analyze = await provider.analyzeTurn(conversationContext, {
      speaker: "CANDIDATE",
      text: answerText,
      timestamp: new Date().toISOString(),
    });

    if (analyze.nextStep?.action === "FINISH") {
      return completeSession({
        access: ensured.access,
        sessionId: ensured.session.id,
        parsedResume: ensured.parsedResume,
        clerkUserId: input.clerkUserId,
      });
    }

    const askedTextSet = new Set(
      turnsAfterCandidate
        .filter((turn) => turn.speaker === "AI")
        .map((turn) => normalizeText(turn.text)),
    );

    const plannedByModel =
      analyze.nextStep?.action === "ASK" ? analyze.nextStep.question?.trim() || null : null;
    const dynamicQuestionFromNextStep =
      plannedByModel && !askedTextSet.has(normalizeText(plannedByModel))
        ? plannedByModel
        : null;

    const dynamicQuestionFromSuggestions = tryPickDynamicQuestion({
      suggestions: analyze.suggestions.map((item) => ({ kind: item.kind, text: item.text })),
      askedTexts: askedTextSet,
    });
    const dynamicQuestion = dynamicQuestionFromNextStep || dynamicQuestionFromSuggestions;

    const fallbackQuestion =
      questionPlan[candidateResponses] ?? fallbackQuestions()[candidateResponses];
    const nextQuestion = dynamicQuestion || fallbackQuestion;

    if (!nextQuestion) {
      return completeSession({
        access: ensured.access,
        sessionId: ensured.session.id,
        parsedResume: ensured.parsedResume,
        clerkUserId: input.clerkUserId,
      });
    }

    await prisma.aiInterviewTurn.create({
      data: {
        sessionId: ensured.session.id,
        speaker: "AI",
        text: nextQuestion,
        questionIdx: askedQuestions + 1,
        isFollowUp: Boolean(dynamicQuestion),
      },
    });

    const updated = await prisma.aiInterviewSession.findUnique({
      where: { id: ensured.session.id },
      include: {
        transcriptTurns: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            speaker: true,
            text: true,
            createdAt: true,
            questionIdx: true,
            isFollowUp: true,
          },
        },
      },
    });

    if (!updated) {
      throw new AiInterviewError("AI interview session not found", 404);
    }

    return getSessionState({
      session: updated,
      turns: toPublicTurns(updated.transcriptTurns),
    });
  } catch (error) {
    toKnownAiInterviewError(error);
  }
}

function normalizeIncomingHash(event: z.infer<typeof proctoringEventSchema>, sessionId: string) {
  const input = `${sessionId}|${event.type}|${event.durationSec}|${event.timestamp}`;
  const serverHash = createHash("sha256").update(input).digest("hex");

  // Keep client hash only if it looks valid; otherwise use server-generated hash.
  if (/^[a-f0-9]{32,128}$/i.test(event.hash.trim())) {
    return event.hash.trim().toLowerCase();
  }

  return serverHash;
}

export async function storeProctoringEvents(input: {
  meetingRoomId: string;
  clerkUserId: string;
  events: unknown[];
}) {
  try {
    if (!Array.isArray(input.events) || input.events.length === 0) {
      return { stored: 0 };
    }

    const ensured = await ensureSession(input.meetingRoomId, input.clerkUserId);

    if (ensured.session.status === "COMPLETED") {
      return { stored: 0 };
    }

    const parsedEvents = input.events.map((event) => proctoringEventSchema.parse(event));
    const hashes = parsedEvents.map((event) => normalizeIncomingHash(event, ensured.session.id));

    const existingHashes = new Set(
      (
        await prisma.aiProctoringEvent.findMany({
          where: {
            sessionId: ensured.session.id,
            hash: { in: hashes },
          },
          select: {
            hash: true,
          },
        })
      ).map((event) => event.hash),
    );

    const data = parsedEvents
      .map((event) => ({
        type: event.type,
        durationSec: event.durationSec,
        hash: normalizeIncomingHash(event, ensured.session.id),
        metadata: event.metadata ?? null,
        occurredAt: new Date(event.timestamp),
      }))
      .filter((event) => !existingHashes.has(event.hash));

    if (data.length === 0) {
      return { stored: 0 };
    }

    await prisma.aiProctoringEvent.createMany({
      data: data.map((event) => ({
        sessionId: ensured.session.id,
        type: event.type,
        durationSec: event.durationSec,
        hash: event.hash,
        metadata: (event.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt: event.occurredAt,
      })),
    });

    return { stored: data.length };
  } catch (error) {
    toKnownAiInterviewError(error);
  }
}

export function toHttpError(error: unknown) {
  if (error instanceof AiInterviewError) {
    return {
      status: error.status,
      message: error.message,
      code: error.code,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      status: 400,
      message: error.issues[0]?.message ?? "Invalid request",
      code: "BAD_REQUEST",
    };
  }

  return {
    status: 500,
    message: error instanceof Error ? error.message : "Unexpected error",
    code: "INTERNAL_SERVER_ERROR",
  };
}
