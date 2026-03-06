import { z } from "zod";

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}(-\d{2})?$/, "Date must use YYYY or YYYY-MM format")
  .max(10);

const optionalShortText = z.string().trim().max(200).optional();
const optionalMediumText = z.string().trim().max(600).optional();
const stringArray = (maxItems: number) =>
  z.array(z.string().trim().min(1).max(120)).max(maxItems).default([]);

const resumeLinkSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(300),
});

const skillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  category: optionalShortText,
});

const workExperienceSchema = z.object({
  company: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(160),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  location: optionalShortText,
  highlights: z.array(z.string().trim().min(1).max(280)).max(12).default([]),
  tech: stringArray(30),
});

const educationSchema = z.object({
  school: z.string().trim().min(1).max(180),
  degree: optionalShortText,
  field: optionalShortText,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  highlights: z.array(z.string().trim().min(1).max(260)).max(10).default([]),
});

const projectSchema = z.object({
  name: z.string().trim().min(1).max(180),
  description: optionalMediumText,
  highlights: z.array(z.string().trim().min(1).max(280)).max(12).default([]),
  tech: stringArray(30),
  link: z.string().trim().url().max(300).optional(),
});

const certificationSchema = z.object({
  name: z.string().trim().min(1).max(180),
  issuer: optionalShortText,
  date: dateSchema.optional(),
});

export const parsedResumeSchema = z.object({
  basics: z.object({
    name: optionalShortText,
    email: z.string().trim().email().max(200).optional(),
    phone: optionalShortText,
    location: optionalShortText,
    links: z.array(resumeLinkSchema).max(20).default([]),
  }),
  summary: optionalMediumText,
  skills: z.array(skillSchema).max(200).default([]),
  workExperience: z.array(workExperienceSchema).max(80).default([]),
  education: z.array(educationSchema).max(40).default([]),
  projects: z.array(projectSchema).max(40).default([]),
  certifications: z.array(certificationSchema).max(40).default([]),
  achievements: z.array(z.string().trim().min(1).max(220)).max(80).default([]),
  keywords: stringArray(200),
});

export const resumeSummarySchema = z.object({
  bullets: z.array(z.string().trim().min(1).max(240)).max(12).default([]),
});

export const suggestedQuestionSchema = z.object({
  question: z.string().trim().min(1).max(280),
  reason: optionalMediumText,
});

export const questionSuggestionSchema = z.object({
  questions: z.array(suggestedQuestionSchema).max(15).default([]),
});

export const aiSuggestionSeveritySchema = z.enum([
  "GOOD",
  "WARN",
  "BAD",
  "NEUTRAL",
  "QUESTION",
]);

export const aiSuggestionKindSchema = z.enum([
  "SUMMARY",
  "FOLLOW_UP",
  "EVAL",
  "QUESTION",
]);

export const transcriptSpeakerSchema = z.enum(["CANDIDATE", "INTERVIEWER"]);

export const aiTurnSuggestionSchema = z.object({
  kind: aiSuggestionKindSchema,
  severity: aiSuggestionSeveritySchema,
  text: z.string().trim().min(1).max(320),
  relatedTo: z.string().trim().max(120).optional(),
});

export const aiNextStepActionSchema = z.enum(["ASK", "FINISH"]);

export const aiNextStepSchema = z
  .object({
    action: aiNextStepActionSchema,
    question: z.string().trim().min(1).max(320).optional(),
    message: z.string().trim().min(1).max(320).optional(),
    reasoning: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "ASK" && !value.question) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["question"],
        message: "question is required when action=ASK",
      });
    }

    if (value.action === "FINISH" && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "message is required when action=FINISH",
      });
    }
  });

export const aiTurnOutputSchema = z.object({
  suggestions: z.array(aiTurnSuggestionSchema).max(6).default([]),
  nextStep: aiNextStepSchema.optional(),
});

export const interviewEvaluationSchema = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1).max(1200),
  strengths: z.array(z.string().trim().min(1).max(240)).max(10).default([]),
  weaknesses: z.array(z.string().trim().min(1).max(240)).max(10).default([]),
  technicalKnowledge: z.number().int().min(0).max(100).optional(),
  problemSolving: z.number().int().min(0).max(100).optional(),
  communication: z.number().int().min(0).max(100).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  malpracticeFlags: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

export type ParsedResume = z.infer<typeof parsedResumeSchema>;
export type ResumeSummary = z.infer<typeof resumeSummarySchema>;
export type QuestionSuggestionSet = z.infer<typeof questionSuggestionSchema>;
export type AiTurnOutput = z.infer<typeof aiTurnOutputSchema>;
export type TranscriptSpeaker = z.infer<typeof transcriptSpeakerSchema>;
export type InterviewEvaluation = z.infer<typeof interviewEvaluationSchema>;
