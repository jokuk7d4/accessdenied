import { z } from "zod";

import type {
  ConversationContext,
  ConversationTurn,
  InterviewContext,
  LLMProvider,
} from "@/lib/ai/provider";
import { ensureLocalModelReady } from "@/lib/ai/local-model-readiness";
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

const DEFAULT_TIMEOUT_MS = 60_000;

type OllamaChatResponse = {
  message?: {
    role?: string;
    content?: string;
  };
  response?: string;
  done?: boolean;
  error?: string;
};

class LocalLlmHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`[local-llm] HTTP ${status}: ${body.slice(0, 500) || "Unknown error"}`);
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(raw: string) {
  return raw.trim().replace(/\/+$/, "");
}

function normalizeEndpoint(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseTimeoutMs(raw: string | undefined) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

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
    throw new Error("[local-llm] Empty model response");
  }

  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutCodeFence);
  } catch {
    const objectStart = withoutCodeFence.indexOf("{");
    const objectEnd = withoutCodeFence.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
      return JSON.parse(withoutCodeFence.slice(objectStart, objectEnd + 1));
    }
    throw new Error("[local-llm] Model did not return valid JSON");
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

export class LocalLlmProvider implements LLMProvider {
  readonly name = "local";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly chatEndpoint: string;
  private readonly generateEndpoint: string;
  private readonly timeoutMs: number;

  constructor() {
    const baseUrlRaw = process.env.LOCAL_LLM_BASE_URL?.trim() ?? "";
    const modelRaw = process.env.LOCAL_LLM_MODEL?.trim() ?? "";

    if (!baseUrlRaw) {
      throw new Error(
        "LOCAL_LLM_BASE_URL is required when AI_PROVIDER=local (example: http://192.168.1.45:11434)",
      );
    }

    if (!modelRaw) {
      throw new Error(
        "LOCAL_LLM_MODEL is required when AI_PROVIDER=local (example: gemma3:4b-it-qat)",
      );
    }

    this.baseUrl = normalizeBaseUrl(baseUrlRaw);
    this.model = modelRaw;
    this.chatEndpoint = normalizeEndpoint(
      process.env.LOCAL_LLM_CHAT_ENDPOINT ?? "/api/chat",
    );
    this.generateEndpoint = normalizeEndpoint(
      process.env.LOCAL_LLM_GENERATE_ENDPOINT ?? "/api/generate",
    );
    this.timeoutMs = parseTimeoutMs(process.env.LOCAL_LLM_TIMEOUT_MS);
  }

  private buildUrl(endpoint: string) {
    return `${this.baseUrl}${endpoint}`;
  }

  private async request(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<OllamaChatResponse> {
    const url = this.buildUrl(endpoint);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new LocalLlmHttpError(response.status, responseText);
      }

      try {
        return JSON.parse(responseText) as OllamaChatResponse;
      } catch {
        throw new Error(
          `[local-llm] Non-JSON response from ${url}: ${responseText.slice(0, 300)}`,
        );
      }
    } catch (error) {
      if (error instanceof LocalLlmHttpError) {
        throw error;
      }

      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new Error(
          `[local-llm] Request timeout after ${this.timeoutMs}ms for ${url}`,
        );
      }

      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new Error(`[local-llm] Unable to reach ${url}: ${message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractContent(response: OllamaChatResponse) {
    if (response.error) {
      throw new Error(`[local-llm] Server error: ${response.error}`);
    }

    const fromChat = response.message?.content?.trim();
    if (fromChat) {
      return fromChat;
    }

    const fromGenerate = response.response?.trim();
    if (fromGenerate) {
      return fromGenerate;
    }

    throw new Error("[local-llm] Empty content in Ollama response");
  }

  private async pingEndpoint(endpoint: string): Promise<void> {
    if (endpoint === this.chatEndpoint) {
      const response = await this.request(endpoint, {
        model: this.model,
        stream: false,
        messages: [
          {
            role: "user",
            content: "Reply with PONG only.",
          },
        ],
        options: {
          temperature: 0,
        },
      });
      const text = this.extractContent(response);
      if (!text.trim()) {
        throw new Error("[local-llm] Empty chat response during connectivity check");
      }
      return;
    }

    const response = await this.request(endpoint, {
      model: this.model,
      stream: false,
      prompt: "Reply with PONG only.",
      options: {
        temperature: 0,
      },
    });
    const text = this.extractContent(response);
    if (!text.trim()) {
      throw new Error("[local-llm] Empty generate response during connectivity check");
    }
  }

  // Called by AI interview setup to fail fast if local Ollama is unreachable.
  async verifyConnection(): Promise<void> {
    await ensureLocalModelReady("generic");
  }

  private async generateRaw(
    prompt: string,
    temperature: number,
    mode: "chat" | "generate",
  ): Promise<string> {
    const strictPrompt = [
      "Return ONLY valid JSON. No markdown. No explanation.",
      prompt,
    ].join("\n\n");

    const primaryEndpoint = mode === "chat" ? this.chatEndpoint : this.generateEndpoint;
    const secondaryEndpoint = mode === "chat" ? this.generateEndpoint : this.chatEndpoint;

    const buildPayload = (endpoint: string) => {
      if (endpoint === this.chatEndpoint) {
        return {
          model: this.model,
          stream: false,
          format: "json",
          messages: [
            {
              role: "user",
              content: strictPrompt,
            },
          ],
          options: {
            temperature,
          },
        };
      }

      return {
        model: this.model,
        stream: false,
        format: "json",
        prompt: strictPrompt,
        options: {
          temperature,
        },
      };
    };

    try {
      const response = await this.request(
        primaryEndpoint,
        buildPayload(primaryEndpoint),
      );
      return this.extractContent(response);
    } catch (error) {
      // Fallback to alternate Ollama endpoint only for HTTP 404 or 405.
      if (
        error instanceof LocalLlmHttpError &&
        (error.status === 404 || error.status === 405)
      ) {
        const fallback = await this.request(
          secondaryEndpoint,
          buildPayload(secondaryEndpoint),
        );
        return this.extractContent(fallback);
      }
      throw error;
    }
  }

  private async generateStructured<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    prompt: string,
    taskName: string,
    mode: "chat" | "generate" = "chat",
  ): Promise<z.infer<TSchema>> {
    let raw = await this.generateRaw(prompt, 0.1, mode);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const parsedJson = parseModelJson(raw);
        const validated = schema.safeParse(parsedJson);

        if (validated.success) {
          return validated.data;
        }

        raw = await this.generateRaw(
          [
            `Repair the JSON output for task "${taskName}".`,
            "Return only valid JSON and nothing else.",
            `Validation errors: ${zodIssueSummary(validated.error)}`,
            "Original output:",
            raw,
          ].join("\n\n"),
          0,
          mode,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        raw = await this.generateRaw(
          [
            `The previous output for task "${taskName}" was not valid JSON.`,
            "Return only valid JSON and nothing else.",
            `Failure reason: ${reason}`,
            "Original output:",
            raw,
          ].join("\n\n"),
          0,
          mode,
        );
      }
    }

    throw new Error(`[local-llm] Unable to produce valid JSON for ${taskName}`);
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

    return this.generateStructured(parsedResumeSchema, prompt, "parseResume", "generate");
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

    return this.generateStructured(resumeSummarySchema, prompt, "summarizeResume", "generate");
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

    return this.generateStructured(questionSuggestionSchema, prompt, "suggestQuestions", "generate");
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

      return this.generateStructured(aiTurnOutputSchema, prompt, "analyzeTurn", "chat");
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

    return this.generateStructured(aiTurnOutputSchema, prompt, "analyzeTurn", "chat");
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
      "chat",
    );
  }
}
