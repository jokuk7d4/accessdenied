import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  initializeAiInterviewSession,
  storeProctoringEvents,
  submitAiCandidateAnswer,
  toHttpError,
} from "@/lib/ai-interview/AIInterviewAgent";

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer"),
    answerText: z.string().trim().min(1).max(6000),
  }),
  z.object({
    action: z.literal("proctor"),
    events: z.array(z.unknown()).min(1).max(50),
  }),
]);

type RouteProps = {
  params: Promise<{ meetingRoomId: string }>;
};

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: RouteProps) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { meetingRoomId } = await params;

    const state = await initializeAiInterviewSession({
      meetingRoomId,
      clerkUserId: userId,
    });

    return NextResponse.json({ ok: true, data: state });
  } catch (error) {
    const httpError = toHttpError(error);
    return NextResponse.json(
      { ok: false, code: httpError.code, error: httpError.message },
      { status: httpError.status },
    );
  }
}

export async function POST(request: Request, { params }: RouteProps) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { meetingRoomId } = await params;
    const body = await request.json();
    const payload = requestSchema.parse(body);

    if (payload.action === "answer") {
      const state = await submitAiCandidateAnswer({
        meetingRoomId,
        clerkUserId: userId,
        answerText: payload.answerText,
      });

      return NextResponse.json({ ok: true, data: state });
    }

    const result = await storeProctoringEvents({
      meetingRoomId,
      clerkUserId: userId,
      events: payload.events,
    });

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const httpError = toHttpError(error);
    return NextResponse.json(
      { ok: false, code: httpError.code, error: httpError.message },
      { status: httpError.status },
    );
  }
}
