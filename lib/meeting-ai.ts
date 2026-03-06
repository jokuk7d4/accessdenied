import type { Prisma } from "@/lib/generated/prisma/client";
import { getProvider } from "@/lib/ai/get-provider";
import type { ConversationTurn, InterviewContext } from "@/lib/ai/provider";
import {
  aiSuggestionKindSchema,
  aiSuggestionSeveritySchema,
  aiTurnOutputSchema,
  parsedResumeSchema,
  questionSuggestionSchema,
  resumeSummarySchema,
  transcriptSpeakerSchema,
  type AiTurnOutput,
  type ParsedResume,
  type QuestionSuggestionSet,
  type ResumeSummary,
} from "@/lib/ai/schemas";
import { prisma } from "@/lib/prisma";

type StoredAiState = {
  aiEnabled: boolean;
  provider: string;
  summary: ResumeSummary | null;
  questions: QuestionSuggestionSet | null;
};

type MeetingContextData = {
  interview: InterviewContext;
  parsedResume: ParsedResume | null;
};

export type PersistedAiSuggestion = {
  id: string;
  kind: "SUMMARY" | "FOLLOW_UP" | "EVAL" | "QUESTION";
  severity: "GOOD" | "WARN" | "BAD" | "NEUTRAL" | "QUESTION";
  text: string;
  relatedToTurnId: string | null;
  createdAt: string;
};

function parseJsonField<T>(
  value: Prisma.JsonValue | null,
  validator: {
    safeParse: (input: unknown) => { success: true; data: T } | { success: false };
  },
): T | null {
  if (!value) {
    return null;
  }

  const parsed = validator.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

async function loadMeetingContext(meetingRoomId: string): Promise<MeetingContextData | null> {
  const room = await prisma.meetingRoom.findUnique({
    where: { id: meetingRoomId },
    select: {
      id: true,
      roundId: true,
      slot: {
        select: {
          id: true,
          candidateEmail: true,
          startAt: true,
          endAt: true,
        },
      },
      round: {
        select: {
          title: true,
          description: true,
          conductedBy: true,
          owner: {
            select: {
              email: true,
            },
          },
        },
      },
    },
  });

  if (!room) {
    return null;
  }

  const membership = await prisma.candidateRoundMembership.findUnique({
    where: {
      roundId_candidateEmail: {
        roundId: room.roundId,
        candidateEmail: room.slot.candidateEmail,
      },
    },
    select: {
      userId: true,
    },
  });

  const parsedResumeRecord = membership
    ? await prisma.parsedResume.findUnique({
        where: {
          candidateUserId_roundId: {
            candidateUserId: membership.userId,
            roundId: room.roundId,
          },
        },
        select: {
          data: true,
        },
      })
    : null;

  const parsedResume = parseJsonField(parsedResumeRecord?.data ?? null, parsedResumeSchema);

  return {
    interview: {
      roundTitle: room.round.title,
      roundDescription: room.round.description,
      conductedBy: room.round.conductedBy,
      ownerEmail: room.round.owner.email ?? null,
      candidateEmail: room.slot.candidateEmail,
      slotStartAt: room.slot.startAt.toISOString(),
      slotEndAt: room.slot.endAt.toISOString(),
    },
    parsedResume,
  };
}

export async function ensureMeetingAiSession(meetingRoomId: string) {
  const provider = getProvider();

  return prisma.meetingAiSession.upsert({
    where: { meetingRoomId },
    create: {
      meetingRoomId,
      provider: provider.name,
      aiEnabled: true,
    },
    update: {},
    select: {
      id: true,
      meetingRoomId: true,
      aiEnabled: true,
      provider: true,
      summary: true,
      questionBank: true,
    },
  });
}

export async function getMeetingAiState(meetingRoomId: string): Promise<StoredAiState> {
  const session = await ensureMeetingAiSession(meetingRoomId);
  return {
    aiEnabled: session.aiEnabled,
    provider: session.provider,
    summary: parseJsonField(session.summary, resumeSummarySchema),
    questions: parseJsonField(session.questionBank, questionSuggestionSchema),
  };
}

export async function ensureMeetingAiInsights(meetingRoomId: string) {
  const provider = getProvider();
  const session = await ensureMeetingAiSession(meetingRoomId);
  const summaryFromDb = parseJsonField(session.summary, resumeSummarySchema);
  const questionsFromDb = parseJsonField(session.questionBank, questionSuggestionSchema);

  if (summaryFromDb && questionsFromDb) {
    return {
      sessionId: session.id,
      aiEnabled: session.aiEnabled,
      provider: session.provider,
      summary: summaryFromDb,
      questions: questionsFromDb,
    };
  }

  const meetingContext = await loadMeetingContext(meetingRoomId);
  if (!meetingContext) {
    throw new Error("Meeting not found for AI context");
  }

  const summary =
    meetingContext.parsedResume !== null
      ? await provider.summarizeResume(meetingContext.parsedResume, meetingContext.interview)
      : {
          bullets: [
            "Resume is not available yet for this candidate.",
            "Use role-specific fundamentals and communication checks.",
          ],
        };

  const questions =
    meetingContext.parsedResume !== null
      ? await provider.suggestQuestions(meetingContext.parsedResume, meetingContext.interview)
      : {
          questions: [
            {
              question: "Walk me through your most recent project and your direct contribution.",
              reason: "Baseline for impact and ownership.",
            },
            {
              question: "What trade-offs did you make and why?",
              reason: "Evaluates decision quality.",
            },
          ],
        };

  await prisma.meetingAiSession.update({
    where: { id: session.id },
    data: {
      summary,
      questionBank: questions,
      provider: provider.name,
    },
  });

  return {
    sessionId: session.id,
    aiEnabled: session.aiEnabled,
    provider: provider.name,
    summary,
    questions,
  };
}

export async function loadMeetingAiSuggestions(
  meetingAiSessionId: string,
  limit = 40,
): Promise<PersistedAiSuggestion[]> {
  const rows = await prisma.meetingAiSuggestion.findMany({
    where: { meetingAiSessionId },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      severity: true,
      text: true,
      relatedToTurnId: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    text: row.text,
    relatedToTurnId: row.relatedToTurnId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function persistTranscriptTurn(input: {
  meetingAiSessionId: string;
  speaker: "CANDIDATE" | "INTERVIEWER";
  speakerUserId: string;
  text: string;
  timestamp: Date;
}) {
  const speaker = transcriptSpeakerSchema.parse(input.speaker);
  return prisma.meetingTranscriptTurn.create({
    data: {
      meetingAiSessionId: input.meetingAiSessionId,
      speaker,
      speakerUserId: input.speakerUserId,
      text: input.text,
      timestamp: input.timestamp,
    },
    select: {
      id: true,
      speaker: true,
      text: true,
      timestamp: true,
    },
  });
}

export async function analyzeTranscriptTurn(params: {
  meetingRoomId: string;
  meetingAiSessionId: string;
  lastTurn: ConversationTurn;
  relatedToTurnId?: string;
}) {
  const provider = getProvider();
  const [session, meetingContext, recentTurns] = await Promise.all([
    prisma.meetingAiSession.findUnique({
      where: { id: params.meetingAiSessionId },
      select: {
        id: true,
        aiEnabled: true,
      },
    }),
    loadMeetingContext(params.meetingRoomId),
    prisma.meetingTranscriptTurn.findMany({
      where: { meetingAiSessionId: params.meetingAiSessionId },
      orderBy: { timestamp: "desc" },
      take: 16,
      select: {
        speaker: true,
        text: true,
        timestamp: true,
      },
    }),
  ]);

  if (!session || !session.aiEnabled || !meetingContext) {
    return [];
  }

  const context = {
    interview: meetingContext.interview,
    resume: meetingContext.parsedResume,
    recentTurns: recentTurns
      .slice()
      .reverse()
      .map((turn) => ({
        speaker: turn.speaker,
        text: turn.text,
        timestamp: turn.timestamp.toISOString(),
      })),
  };

  const aiResult = aiTurnOutputSchema.parse(
    await provider.analyzeTurn(context, params.lastTurn),
  );

  if (aiResult.suggestions.length === 0) {
    return [];
  }

  await prisma.meetingAiSuggestion.createMany({
    data: aiResult.suggestions.map((suggestion) => ({
      meetingAiSessionId: params.meetingAiSessionId,
      kind: aiSuggestionKindSchema.parse(suggestion.kind),
      severity: aiSuggestionSeveritySchema.parse(suggestion.severity),
      text: suggestion.text,
      relatedToTurnId: params.relatedToTurnId ?? suggestion.relatedTo ?? null,
    })),
  });

  const stored = await prisma.meetingAiSuggestion.findMany({
    where: { meetingAiSessionId: params.meetingAiSessionId },
    orderBy: { createdAt: "desc" },
    take: aiResult.suggestions.length,
    select: {
      id: true,
      kind: true,
      severity: true,
      text: true,
      relatedToTurnId: true,
      createdAt: true,
    },
  });

  return stored
    .slice()
    .reverse()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      text: row.text,
      relatedToTurnId: row.relatedToTurnId,
      createdAt: row.createdAt.toISOString(),
    }));
}
