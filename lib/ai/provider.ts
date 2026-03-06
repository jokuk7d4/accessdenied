import type {
  AiTurnOutput,
  InterviewEvaluation,
  ParsedResume,
  QuestionSuggestionSet,
  ResumeSummary,
  TranscriptSpeaker,
} from "@/lib/ai/schemas";

export type InterviewContext = {
  roundTitle: string;
  roundDescription: string | null;
  conductedBy: "HUMAN" | "AI";
  ownerEmail: string | null;
  candidateEmail: string;
  slotStartAt: string;
  slotEndAt: string;
};

export type ConversationTurn = {
  speaker: TranscriptSpeaker;
  text: string;
  timestamp: string;
};

export type ConversationContext = {
  interview: InterviewContext;
  resume: ParsedResume | null;
  recentTurns: ConversationTurn[];
  aiInterviewMeta?: {
    maxQuestions: number;
    currentQuestionCount: number;
    interviewMode: "voice";
    browserWillReadAloud: boolean;
  };
};

export type ProctoringSignal = {
  type: "LOOK_LEFT" | "LOOK_RIGHT" | "LOOK_DOWN" | "MULTIPLE_WARNINGS";
  durationSec: number;
  timestamp: string;
};

export interface LLMProvider {
  readonly name: string;
  parseResume(text: string): Promise<ParsedResume>;
  summarizeResume(
    resume: ParsedResume,
    context: InterviewContext,
  ): Promise<ResumeSummary>;
  suggestQuestions(
    resume: ParsedResume,
    context: InterviewContext,
  ): Promise<QuestionSuggestionSet>;
  analyzeTurn(
    context: ConversationContext,
    lastTurn: ConversationTurn,
  ): Promise<AiTurnOutput>;
  evaluateInterview(
    context: ConversationContext,
    transcript: ConversationTurn[],
    proctoringSignals: ProctoringSignal[],
  ): Promise<InterviewEvaluation>;
}
