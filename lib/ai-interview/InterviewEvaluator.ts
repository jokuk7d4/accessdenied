import type { ConversationContext, ConversationTurn, ProctoringSignal } from "@/lib/ai/provider";
import type { InterviewEvaluation } from "@/lib/ai/schemas";
import { getProvider } from "@/lib/ai/get-provider";

const PENALTY_PER_MAJOR_LOOK_AWAY = 5;
const PENALTY_MULTIPLE_WARNINGS = 10;

function clampScore(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

export function computeMalpracticePenalty(signals: ProctoringSignal[]) {
  const majorSignals = signals.filter((signal) => signal.durationSec >= 3);
  let penalty = majorSignals.length * PENALTY_PER_MAJOR_LOOK_AWAY;

  if (majorSignals.length >= 3) {
    penalty += PENALTY_MULTIPLE_WARNINGS;
  }

  return {
    penalty,
    majorSignals,
  };
}

export async function evaluateInterviewWithPenalty(input: {
  context: ConversationContext;
  transcript: ConversationTurn[];
  proctoringSignals: ProctoringSignal[];
}): Promise<{
  evaluation: InterviewEvaluation;
  aiScore: number;
  finalScore: number;
  penalty: number;
}> {
  const provider = getProvider();
  const evaluation = await provider.evaluateInterview(
    input.context,
    input.transcript,
    input.proctoringSignals,
  );

  const aiScore = clampScore(evaluation.score);
  const { penalty } = computeMalpracticePenalty(input.proctoringSignals);
  const finalScore = clampScore(aiScore - penalty);

  return {
    evaluation,
    aiScore,
    finalScore,
    penalty,
  };
}
