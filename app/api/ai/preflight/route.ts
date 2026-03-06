import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ensureLocalModelReady,
  isLocalModelReadinessError,
} from "@/lib/ai/local-model-readiness";

const taskSchema = z.enum(["resume-parse", "ai-interview", "generic"]);

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const task = taskSchema.parse(url.searchParams.get("task") ?? "generic");
    const result = await ensureLocalModelReady(task);

    return NextResponse.json({
      ok: true,
      data: result,
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

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.issues[0]?.message ?? "Invalid preflight request",
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to verify local AI readiness",
      },
      { status: 500 },
    );
  }
}

