import { prisma } from "@/lib/prisma";
import { resolveMeetingAccessByRoomId } from "@/lib/meetingAccess";
import { statusAfterJoin } from "@/lib/meeting-policy";

type LifecycleFailure = {
  ok: false;
  status: number;
  message: string;
};

type JoinSuccess = {
  ok: true;
  meetingRoomId: string;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED";
  joinCount: number;
  joinUrl: string;
  completedAt: string | null;
};

type CompleteSuccess = {
  ok: true;
  meetingRoomId: string;
  status: "COMPLETED";
  alreadyCompleted: boolean;
  completedAt: string;
};

export type JoinMeetingResult = LifecycleFailure | JoinSuccess;
export type CompleteMeetingResult = LifecycleFailure | CompleteSuccess;

export async function joinMeetingRoom(params: {
  meetingRoomId: string;
  clerkUserId: string;
}): Promise<JoinMeetingResult> {
  const access = await resolveMeetingAccessByRoomId(
    params.meetingRoomId,
    params.clerkUserId,
  );

  if (!access.ok) {
    return access;
  }

  if (!access.canJoin) {
    return {
      ok: false,
      status: 409,
      message: "Meeting completed",
    };
  }

  await prisma.meetingRoom.updateMany({
    where: {
      id: access.room.id,
      status: "SCHEDULED",
      completedAt: null,
      endedAt: null,
    },
    data: {
      status: statusAfterJoin("SCHEDULED"),
    },
  });

  const joinCountUpdate = await prisma.meetingRoom.updateMany({
    where: {
      id: access.room.id,
      status: {
        not: "COMPLETED",
      },
      completedAt: null,
      endedAt: null,
    },
    data: {
      joinCount: {
        increment: 1,
      },
    },
  });

  if (joinCountUpdate.count === 0) {
    return {
      ok: false,
      status: 409,
      message: "Meeting completed",
    };
  }

  const updatedRoom = await prisma.meetingRoom.findUnique({
    where: { id: access.room.id },
    select: {
      status: true,
      joinCount: true,
      completedAt: true,
      endedAt: true,
      meetingToken: true,
    },
  });

  if (!updatedRoom) {
    return {
      ok: false,
      status: 404,
      message: "Meeting not found",
    };
  }

  return {
    ok: true,
    meetingRoomId: access.room.id,
    status:
      updatedRoom.status === "COMPLETED" || updatedRoom.completedAt || updatedRoom.endedAt
        ? "COMPLETED"
        : updatedRoom.status,
    joinCount: updatedRoom.joinCount,
    joinUrl: `/meet/${updatedRoom.meetingToken}`,
    completedAt: (updatedRoom.completedAt ?? updatedRoom.endedAt)?.toISOString() ?? null,
  };
}

export async function completeMeetingRoom(params: {
  meetingRoomId: string;
  clerkUserId: string;
}): Promise<CompleteMeetingResult> {
  const access = await resolveMeetingAccessByRoomId(
    params.meetingRoomId,
    params.clerkUserId,
  );

  if (!access.ok) {
    return access;
  }

  if (!access.canMarkCompleted) {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: write access is required to mark this meeting completed",
    };
  }

  const completionTime = new Date();

  const update = await prisma.meetingRoom.updateMany({
    where: {
      id: access.room.id,
      status: {
        not: "COMPLETED",
      },
    },
    data: {
      status: "COMPLETED",
      completedAt: completionTime,
      completedByUserId: access.user.id,
      endedAt: completionTime,
      endedByUserId: access.user.id,
    },
  });

  await prisma.meetingParticipant.updateMany({
    where: {
      meetingRoomId: access.room.id,
      leftAt: null,
    },
    data: {
      leftAt: completionTime,
    },
  });

  await prisma.meetingAiSession.updateMany({
    where: {
      meetingRoomId: access.room.id,
      endedAt: null,
    },
    data: {
      endedAt: completionTime,
      aiEnabled: false,
    },
  });

  if (update.count === 0) {
    const existing = await prisma.meetingRoom.findUnique({
      where: { id: access.room.id },
      select: {
        completedAt: true,
        endedAt: true,
      },
    });

    return {
      ok: true,
      meetingRoomId: access.room.id,
      status: "COMPLETED",
      alreadyCompleted: true,
      completedAt:
        (existing?.completedAt ?? existing?.endedAt ?? completionTime).toISOString(),
    };
  }

  return {
    ok: true,
    meetingRoomId: access.room.id,
    status: "COMPLETED",
    alreadyCompleted: false,
    completedAt: completionTime.toISOString(),
  };
}
