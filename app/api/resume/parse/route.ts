import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getProvider } from "@/lib/ai/get-provider";
import {
  ensureLocalModelReady,
  isLocalModelReadinessError,
} from "@/lib/ai/local-model-readiness";
import type { ParsedResume } from "@/lib/ai/schemas";
import { prisma } from "@/lib/prisma";
import { extractResumeText } from "@/lib/resume/extract-text";
import { fallbackParseResume } from "@/lib/resume/fallback-parse";
import { resolveMeetingAccess } from "@/lib/meetingAccess";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const RESUME_SCHEMA_VERSION = 1;
const LOCAL_PARSE_TIMEOUT_MS = 20_000;

export const runtime = "nodejs";

function isQuotaError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("google ai request failed: 429") ||
    message.includes("resource_exhausted") ||
    (message.includes("quota") && message.includes("google ai"))
  );
}

function isGoogleApiError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  // Catches 400 bad model name, 403 auth, 404 model not found, 5xx server errors, etc.
  return error.message.toLowerCase().includes("google ai request failed");
}

function isStructuredParseError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("unable to produce valid json for parseresume") ||
    message.includes("unable to produce valid json for parsereseum") ||
    message.includes("model did not return valid json")
  );
}

function isLocalProviderEnabled() {
  return (process.env.AI_PROVIDER?.trim().toLowerCase() ?? "google") === "local";
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

export async function POST(request: Request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const meetingToken = String(formData.get("meetingToken") ?? "").trim();
    const file = formData.get("file");

    if (!meetingToken) {
      return NextResponse.json(
        { ok: false, error: "Meeting token is required" },
        { status: 400 },
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Resume file is required" },
        { status: 400 },
      );
    }

    if (file.size <= 0) {
      return NextResponse.json(
        { ok: false, error: "Uploaded file is empty" },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { ok: false, error: "Resume file must be 10MB or smaller" },
        { status: 400 },
      );
    }

    const access = await resolveMeetingAccess(meetingToken, userId);

    if (!access.ok) {
      return NextResponse.json(
        { ok: false, error: access.message },
        { status: access.status },
      );
    }

    if (access.viewerRole !== "CANDIDATE") {
      return NextResponse.json(
        { ok: false, error: "Only candidates can upload resumes" },
        { status: 403 },
      );
    }

    try {
      await ensureLocalModelReady("resume-parse");
    } catch (preflightError) {
      if (isLocalModelReadinessError(preflightError)) {
        return NextResponse.json(
          {
            ok: false,
            code: preflightError.code,
            error: preflightError.message,
            details: preflightError.details,
          },
          { status: preflightError.status },
        );
      }
      throw preflightError;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const extractedText = await extractResumeText(bytes, file.name, file.type);
    const provider = getProvider();

    let parsedResume: ParsedResume;
    let usedFallback = false;
    let geminiError: string | undefined;

    try {
      const parsePromise = provider.parseResume(extractedText);
      parsedResume = isLocalProviderEnabled()
        ? await withTimeout(parsePromise, LOCAL_PARSE_TIMEOUT_MS, "Local resume parsing")
        : await parsePromise;
    } catch (error) {
      // Fallback for: quota errors, bad JSON from model, any Google API error
      // (bad model name, auth failure, network error), or local provider issues.
      const allowFallback =
        isQuotaError(error) ||
        isStructuredParseError(error) ||
        isGoogleApiError(error) ||
        isLocalProviderEnabled();

      // Capture the real reason for logging and returning to the client
      geminiError = error instanceof Error ? error.message : String(error);
      console.error("[resume/parse] AI provider failed, reason:", geminiError);

      if (!allowFallback) {
        throw error;
      }

      try {
        usedFallback = true;
        parsedResume = fallbackParseResume(extractedText);
      } catch {
        return NextResponse.json(
          {
            ok: false,
            code: isLocalProviderEnabled() ? "LOCAL_MODEL_UNAVAILABLE" : undefined,
            error: "Unable to parse resume. Please upload a clearer PDF/DOCX.",
            aiError: geminiError,
          },
          { status: 500 },
        );
      }
    }

    await prisma.parsedResume.upsert({
      where: {
        candidateUserId_roundId: {
          candidateUserId: access.user.id,
          roundId: access.room.roundId,
        },
      },
      create: {
        candidateUserId: access.user.id,
        roundId: access.room.roundId,
        schemaVersion: RESUME_SCHEMA_VERSION,
        data: parsedResume,
      },
      update: {
        schemaVersion: RESUME_SCHEMA_VERSION,
        data: parsedResume,
      },
    });

    return NextResponse.json({
      ok: true,
      message: usedFallback
        ? "Resume parsed with fallback mode (AI unavailable)"
        : "Resume parsed successfully",
      usedQuotaFallback: usedFallback,
      aiError: usedFallback ? geminiError : undefined,
    });
  } catch (error) {
    if (isLocalModelReadinessError(error)) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
          details: error.details,
        },
        { status: error.status },
      );
    }

    console.error("[resume/parse] Unhandled error:", error);
    return NextResponse.json(
      { ok: false, error: "Unable to parse resume. Please try again.", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
