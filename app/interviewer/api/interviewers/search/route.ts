import { NextResponse } from "next/server";

import { AccessError, requireInterviewer } from "@/lib/roundAccess";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  try {
    const { user } = await requireInterviewer();
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim().toLowerCase() ?? "";

    if (!query) {
      return NextResponse.json([]);
    }

    const interviewers = await prisma.user.findMany({
      where: {
        role: "INTERVIEWER",
        email: {
          contains: query,
          mode: "insensitive",
        },
        id: {
          not: user.id,
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        clerkUserId: true,
      },
      take: 10,
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(interviewers);
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: "Unable to search interviewers" }, { status: 500 });
  }
}
