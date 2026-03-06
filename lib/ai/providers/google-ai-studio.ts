import { z } from "zod";

import type {
  ConversationContext,
  ConversationTurn,
  InterviewContext,
  LLMProvider,
} from "@/lib/ai/provider";
import {
  aiTurnOutputSchema,
  interviewEvaluationSchema,
  parsedResumeSchema,
  questionSuggestionSchema,
  resumeSummarySchema,
  type AiTurnOutput,
  type InterviewEvaluation,
  type ParsedResume,
  type QuestionSuggestionSet,
  type ResumeSummary,
} from "@/lib/ai/schemas";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
};

function stringifySafe(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function zodIssueSummary(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty model response");
  }

  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutCodeFence);
  } catch {
    const start = withoutCodeFence.indexOf("{");
    const end = withoutCodeFence.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(withoutCodeFence.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }
}

function compactResumeForAnalysis(resume: ParsedResume | null) {
  if (!resume) {
    return null;
  }

  return {
    basics: resume.basics,
    summary: resume.summary,
    keywords: resume.keywords.slice(0, 40),
    skills: resume.skills.slice(0, 40),
    workExperience: resume.workExperience.slice(0, 8),
    projects: resume.projects.slice(0, 8),
    education: resume.education.slice(0, 6),
    certifications: resume.certifications.slice(0, 10),
    achievements: resume.achievements.slice(0, 20),
  };
}

export class GoogleAiStudioProvider implements LLMProvider {
  readonly name = "google";
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.GOOGLE_AI_API_KEY?.trim() ?? "";
    this.model = process.env.GOOGLE_AI_MODEL?.trim() || "gemini-2.0-flash";

    if (!this.apiKey) {
      throw new Error("GOOGLE_AI_API_KEY is required for AI_PROVIDER=google");
    }
  }

  private async generate(prompt: string, temperature = 0.1): Promise<string> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google AI request failed: ${response.status} ${detail}`);
    }

    const payload = (await response.json()) as GeminiResponse;
    const text =
      payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("\n")
        .trim() ?? "";

    if (!text) {
      throw new Error(
        payload.promptFeedback?.blockReason
          ? `Google AI response blocked: ${payload.promptFeedback.blockReason}`
          : "Google AI returned an empty response",
      );
    }

    return text;
  }

  private async generateStructured<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    prompt: string,
    taskName: string,
  ): Promise<z.infer<TSchema>> {
    let raw = await this.generate(prompt);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const parsedJson = parseModelJson(raw);
        const validated = schema.safeParse(parsedJson);

        if (validated.success) {
          return validated.data;
        }

        raw = await this.generate(
          [
            `Repair the JSON output for task "${taskName}".`,
            "Return only valid JSON and nothing else.",
            `Validation errors: ${zodIssueSummary(validated.error)}`,
            "Original output:",
            raw,
          ].join("\n\n"),
          0,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        raw = await this.generate(
          [
            `The previous output for task "${taskName}" was not valid JSON.`,
            "Return only valid JSON and nothing else.",
            `Failure reason: ${reason}`,
            "Original output:",
            raw,
          ].join("\n\n"),
          0,
        );
      }
    }

    throw new Error(`Unable to produce valid JSON for ${taskName}`);
  }

  async parseResume(text: string): Promise<ParsedResume> {
    const prompt = [
      "Extract resume information from the provided raw text.",
      "Return ONLY a valid JSON object.",
      "Output shape:",
      stringifySafe({
        basics: {
          name: "string?",
          email: "string?",
          phone: "string?",
          location: "string?",
          links: [{ label: "string", url: "https://..." }],
        },
        summary: "string?",
        skills: [{ name: "string", category: "string?" }],
        workExperience: [
          {
            company: "string",
            title: "string",
            startDate: "YYYY or YYYY-MM",
            endDate: "YYYY or YYYY-MM",
            location: "string?",
            highlights: ["string"],
            tech: ["string"],
          },
        ],
        education: [
          {
            school: "string",
            degree: "string?",
            field: "string?",
            startDate: "YYYY or YYYY-MM",
            endDate: "YYYY or YYYY-MM",
            highlights: ["string"],
          },
        ],
        projects: [
          {
            name: "string",
            description: "string?",
            highlights: ["string"],
            tech: ["string"],
            link: "https://...?",
          },
        ],
        certifications: [{ name: "string", issuer: "string?", date: "YYYY or YYYY-MM" }],
        achievements: ["string"],
        keywords: ["string"],
      }),
      "Rules:",
      "- No null array items.",
      "- Keep only factual resume-derived content.",
      "- Dates must be YYYY or YYYY-MM if present.",
      "- Avoid extra keys.",
      "",
      "RESUME_TEXT:",
      text.slice(0, 120_000),
    ].join("\n");

    return this.generateStructured(parsedResumeSchema, prompt, "parseResume");
  }

  async summarizeResume(
    resume: ParsedResume,
    context: InterviewContext,
  ): Promise<ResumeSummary> {
    const prompt = [
      "You are assisting interviewers in a live HUMAN interview.",
      "Create a concise bullet digest from the parsed resume for interviewer use.",
      "Return ONLY JSON.",
      "Output shape:",
      stringifySafe({ bullets: ["string"] }),
      "Interview context:",
      stringifySafe(context),
      "Parsed resume:",
      stringifySafe(resume),
    ].join("\n\n");

    return this.generateStructured(resumeSummarySchema, prompt, "summarizeResume");
  }

  async suggestQuestions(
    resume: ParsedResume,
    context: InterviewContext,
  ): Promise<QuestionSuggestionSet> {
    const prompt = [
      "Generate practical interview questions tailored to the candidate resume.",
      "Return ONLY JSON.",
      "Output shape:",
      stringifySafe({
        questions: [{ question: "string", reason: "string?" }],
      }),
      "Interview context:",
      stringifySafe(context),
      "Parsed resume:",
      stringifySafe(resume),
    ].join("\n\n");

    return this.generateStructured(
      questionSuggestionSchema,
      prompt,
      "suggestQuestions",
    );
  }

  async analyzeTurn(
    context: ConversationContext,
    lastTurn: ConversationTurn,
  ): Promise<AiTurnOutput> {
    if (context.aiInterviewMeta) {
      const prompt = [
        "Resume:",
        stringifySafe(compactResumeForAnalysis(context.resume)),
        "",
        "Interview metadata:",
        `- maxQuestions: ${context.aiInterviewMeta.maxQuestions}`,
        `- currentQuestionCount: ${context.aiInterviewMeta.currentQuestionCount}`,
        `- interviewMode: ${context.aiInterviewMeta.interviewMode}`,
        `- browserWillReadAloud: ${context.aiInterviewMeta.browserWillReadAloud}`,
        "",
        "Conversation so far:",
        stringifySafe(context.recentTurns.slice(-20)),
        "",
        "Latest candidate response:",
        stringifySafe(lastTurn),
        "",
        "Instruction:",
        "Based on the resume and the conversation so far, return the next best interview step.",
        "If enough information is collected or max questions reached, return a finish response.",
        "Return JSON only.",
        "Output shape:",
        stringifySafe({
          nextStep: {
            action: "ASK|FINISH",
            question: "string (required when action=ASK)",
            message: "string (required when action=FINISH)",
            reasoning: "optional short reason",
          },
          suggestions: [
            {
              kind: "SUMMARY|FOLLOW_UP|EVAL|QUESTION",
              severity: "GOOD|WARN|BAD|NEUTRAL|QUESTION",
              text: "string",
              relatedTo: "optional short label",
            },
          ],
        }),
        "Rules:",
        "- Do not ask repeated questions.",
        "- Keep question concise and specific.",
        "- suggestions can be empty if not needed.",
      ].join("\n");

      return this.generateStructured(aiTurnOutputSchema, prompt, "analyzeTurn");
    }

    const prompt = [
      "You are an interviewer copilot in a HUMAN interview.",
      "Analyze the latest transcript turn and suggest next interviewer actions.",
      "Return ONLY JSON.",
      "Output shape:",
      stringifySafe({
        suggestions: [
          {
            kind: "SUMMARY|FOLLOW_UP|EVAL|QUESTION",
            severity: "GOOD|WARN|BAD|NEUTRAL|QUESTION",
            text: "string",
            relatedTo: "optional short label",
          },
        ],
      }),
      "Guidance:",
      "- EVAL should reflect confidence/quality hints.",
      "- FOLLOW_UP should propose probing prompts.",
      "- QUESTION should be direct interview questions.",
      "- Keep suggestions short and actionable.",
      "Interview context:",
      stringifySafe(context.interview),
      "Resume digest:",
      stringifySafe(compactResumeForAnalysis(context.resume)),
      "Recent turns:",
      stringifySafe(context.recentTurns.slice(-10)),
      "Last turn:",
      stringifySafe(lastTurn),
    ].join("\n\n");

    return this.generateStructured(aiTurnOutputSchema, prompt, "analyzeTurn");
  }

  async evaluateInterview(
    context: ConversationContext,
    transcript: ConversationTurn[],
    proctoringSignals: Array<{
      type: "LOOK_LEFT" | "LOOK_RIGHT" | "LOOK_DOWN" | "MULTIPLE_WARNINGS";
      durationSec: number;
      timestamp: string;
    }>,
  ): Promise<InterviewEvaluation> {
    const prompt = [
      "You are an expert interviewer evaluator.",
      "Evaluate the interview and return strict JSON only.",
      "Scoring categories: technical knowledge, problem solving, communication, confidence.",
      "Output shape:",
      stringifySafe({
        score: 0,
        summary: "string",
        strengths: ["string"],
        weaknesses: ["string"],
        technicalKnowledge: 0,
        problemSolving: 0,
        communication: 0,
        confidence: 0,
        malpracticeFlags: ["string"],
      }),
      "Rules:",
      "- score must be 0-100 before malpractice penalty adjustments",
      "- strengths/weaknesses must be concrete and interview-grounded",
      "- keep summary concise and actionable",
      "Interview context:",
      stringifySafe(context.interview),
      "Resume digest:",
      stringifySafe(compactResumeForAnalysis(context.resume)),
      "Transcript:",
      stringifySafe(transcript.slice(-80)),
      "Proctoring signals:",
      stringifySafe(proctoringSignals.slice(-40)),
    ].join("\n\n");

    return this.generateStructured(
      interviewEvaluationSchema,
      prompt,
      "evaluateInterview",
    );
  }
}
