import { prisma } from "@/lib/prisma";
import { hashMeetingToken } from "@/lib/meeting";
import {
  canJoinMeeting,
  canMarkMeetingCompleted,
  hasMeetingWriteAccess,
  type MeetingParticipantKind,
  type MeetingStatus,
} from "@/lib/meeting-policy";

export type MeetingJoinBlockedReason = "MEETING_ENDED";
export type MeetingViewerRole = "INTERVIEWER" | "CANDIDATE";

export type MeetingAccessResult =
  | {
      ok: false;
      status: number;
      message: string;
    }
  | {
      ok: true;
      canJoin: boolean;
      joinBlockedReason: MeetingJoinBlockedReason | null;
      viewerRole: MeetingViewerRole;
      participantKind: MeetingParticipantKind;
      isOwner: boolean;
      hasWriteAccess: boolean;
      canMarkCompleted: boolean;
      activeInterviewerCount: number;
      user: {
        id: string;
        clerkUserId: string;
        role: "INTERVIEWER" | "CANDIDATE";
        email: string | null;
        name: string | null;
      };
      room: {
        id: string;
        roundId: string;
        roundTitle: string;
        roundDescription: string | null;
        roundConductedBy: "AI" | "HUMAN";
        roundOwnerEmail: string | null;
        slotId: string;
        slotCandidateEmail: string;
        slotStartAt: Date;
        slotEndAt: Date;
        status: MeetingStatus;
        joinCount: number;
        completedAt: Date | null;
        completedByUserId: string | null;
        endedAt: Date | null;
        token: string;
      };
    };

type ResolveRoomQuery =
  | { kind: "token"; meetingToken: string }
  | { kind: "id"; meetingRoomId: string };

function normalizeEmail(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

async function resolveMeetingAccessInternal(
  query: ResolveRoomQuery,
  clerkUserId: string,
): Promise<MeetingAccessResult> {
  const where =
    query.kind === "token"
      ? { meetingTokenHash: hashMeetingToken(query.meetingToken.trim()) }
      : { id: query.meetingRoomId };

  if (query.kind === "token" && !query.meetingToken.trim()) {
    return { ok: false, status: 400, message: "Meeting token is missing" };
  }

  const [user, room] = await Promise.all([
    prisma.user.findUnique({
      where: { clerkUserId },
      select: {
        id: true,
        clerkUserId: true,
        role: true,
        email: true,
        name: true,
      },
    }),
    prisma.meetingRoom.findUnique({
      where,
      select: {
        id: true,
        roundId: true,
        meetingToken: true,
        status: true,
        joinCount: true,
        completedAt: true,
        completedByUserId: true,
        endedAt: true,
        slot: {
          select: {
            id: true,
            candidateEmail: true,
            startAt: true,
            endAt: true,
            round: {
              select: {
                id: true,
                title: true,
                description: true,
                conductedBy: true,
                ownerId: true,
                owner: {
                  select: {
                    email: true,
                  },
                },
                invites: {
                  where: { status: "ACCEPTED" },
                  select: {
                    inviteeId: true,
                    permissions: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  if (!user) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  if (!room) {
    return { ok: false, status: 404, message: "Meeting not found" };
  }

  const activeInterviewerCount = await prisma.meetingParticipant.count({
    where: {
      meetingRoomId: room.id,
      role: "INTERVIEWER",
      leftAt: null,
    },
  });

  let viewerRole: MeetingViewerRole;
  let participantKind: MeetingParticipantKind;
  let isOwner = false;
  let invitePermissions: Array<
    "READ" | "MANAGE_INVITEES" | "MANAGE_CANDIDATES" | "FULL"
  > = [];

  if (user.role === "INTERVIEWER") {
    const acceptedInvite = room.slot.round.invites.find(
      (invite) => invite.inviteeId === user.id,
    );
    isOwner = room.slot.round.ownerId === user.id;
    const isAcceptedGuest = Boolean(acceptedInvite);

    if (!isOwner && !isAcceptedGuest) {
      return { ok: false, status: 403, message: "Not authorized for this meeting" };
    }

    viewerRole = "INTERVIEWER";
    participantKind = isOwner ? "OWNER" : "GUEST_INTERVIEWER";
    invitePermissions = acceptedInvite?.permissions ?? [];
  } else {
    const membership = await prisma.candidateRoundMembership.findUnique({
      where: {
        roundId_userId: {
          roundId: room.roundId,
          userId: user.id,
        },
      },
      select: {
        candidateEmail: true,
      },
    });

    if (!membership) {
      return {
        ok: false,
        status: 403,
        message: "You have not accepted this round invitation",
      };
    }

    const membershipEmail = normalizeEmail(membership.candidateEmail);
    const slotEmail = normalizeEmail(room.slot.candidateEmail);
    const userEmail = normalizeEmail(user.email);

    if (membershipEmail !== slotEmail || userEmail !== slotEmail) {
      return {
        ok: false,
        status: 403,
        message: `This meeting is for ${slotEmail}. Sign in with that account.`,
      };
    }

    viewerRole = "CANDIDATE";
    participantKind = "CANDIDATE";
  }

  const completed =
    room.status === "COMPLETED" || Boolean(room.completedAt || room.endedAt);
  const canJoin = canJoinMeeting(completed ? "COMPLETED" : room.status);
  const hasWriteAccess = hasMeetingWriteAccess({
    participantKind,
    invitePermissions,
  });
  const canMarkCompleted = canMarkMeetingCompleted({
    participantKind,
    invitePermissions,
  });

  return {
    ok: true,
    canJoin,
    joinBlockedReason: canJoin ? null : "MEETING_ENDED",
    viewerRole,
    participantKind,
    isOwner,
    hasWriteAccess,
    canMarkCompleted,
    activeInterviewerCount,
    user: {
      id: user.id,
      clerkUserId: user.clerkUserId,
      role: user.role,
      email: user.email,
      name: user.name,
    },
    room: {
      id: room.id,
      roundId: room.roundId,
      roundTitle: room.slot.round.title,
      roundDescription: room.slot.round.description,
      roundConductedBy: room.slot.round.conductedBy,
      roundOwnerEmail: room.slot.round.owner.email,
      slotId: room.slot.id,
      slotCandidateEmail: room.slot.candidateEmail,
      slotStartAt: room.slot.startAt,
      slotEndAt: room.slot.endAt,
      status: completed ? "COMPLETED" : room.status,
      joinCount: room.joinCount,
      completedAt: room.completedAt ?? room.endedAt,
      completedByUserId: room.completedByUserId,
      endedAt: room.endedAt,
      token: room.meetingToken,
    },
  };
}

export async function resolveMeetingAccess(
  meetingToken: string,
  clerkUserId: string,
): Promise<MeetingAccessResult> {
  return resolveMeetingAccessInternal({ kind: "token", meetingToken }, clerkUserId);
}

export async function resolveMeetingAccessByRoomId(
  meetingRoomId: string,
  clerkUserId: string,
): Promise<MeetingAccessResult> {
  return resolveMeetingAccessInternal({ kind: "id", meetingRoomId }, clerkUserId);
}
