import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { joinMeetingRoom } from "@/lib/meeting-lifecycle";

type RouteContext = {
  params: Promise<{ meetingId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { meetingId } = await context.params;
  const result = await joinMeetingRoom({
    meetingRoomId: meetingId,
    clerkUserId: userId,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.message },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    data: result,
  });
}
