import { auth } from "@clerk/nextjs/server";

import { prisma } from "@/lib/prisma";
import { syncUser } from "@/lib/syncUser";

export class AccessError extends Error {
  status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

type EffectivePermissions = {
  read: boolean;
  manageInvitees: boolean;
  manageCandidates: boolean;
  full: boolean;
};

type RoundInviteRecord = {
  id: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "REVOKED";
  permissions: Array<"READ" | "MANAGE_INVITEES" | "MANAGE_CANDIDATES" | "FULL">;
};

type RoundState = {
  id: string;
  ownerId: string;
  closedAt: Date | null;
  deletedAt: Date | null;
  schedulingLocked: boolean;
};

export type RoundAccess = {
  isOwner: boolean;
  invite: RoundInviteRecord | null;
  permissions: EffectivePermissions;
  round: RoundState;
};

export async function requireInterviewer() {
  const { userId } = await auth();

  if (!userId) {
    throw new AccessError("Unauthorized", 401);
  }

  const user = await syncUser("INTERVIEWER", userId);

  if (!user || user.role !== "INTERVIEWER") {
    throw new AccessError("Interviewer access required", 403);
  }

  return { clerkUserId: userId, user };
}

export async function getRoundAccess(roundId: string, clerkUserId: string): Promise<RoundAccess | null> {
  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    select: { id: true },
  });

  if (!user) {
    return null;
  }

  const round = await prisma.interviewRound.findUnique({
    where: { id: roundId },
    select: {
      id: true,
      ownerId: true,
      closedAt: true,
      deletedAt: true,
      schedulingLocked: true,
    },
  });

  if (!round || round.deletedAt) {
    return null;
  }

  const invite = await prisma.roundInterviewerInvite.findUnique({
    where: {
      roundId_inviteeId: {
        roundId,
        inviteeId: user.id,
      },
    },
    select: {
      id: true,
      status: true,
      permissions: true,
    },
  });

  const isOwner = round.ownerId === user.id;
  const inviteAccepted = invite?.status === "ACCEPTED";
  const hasFull = isOwner || Boolean(inviteAccepted && invite?.permissions.includes("FULL"));
  const canManageInvitees =
    isOwner ||
    hasFull ||
    Boolean(inviteAccepted && invite?.permissions.includes("MANAGE_INVITEES"));
  const canManageCandidates =
    isOwner ||
    hasFull ||
    Boolean(inviteAccepted && invite?.permissions.includes("MANAGE_CANDIDATES"));
  const canRead =
    isOwner ||
    Boolean(
      inviteAccepted &&
        (hasFull ||
          invite?.permissions.includes("READ") ||
          invite?.permissions.includes("MANAGE_INVITEES") ||
          invite?.permissions.includes("MANAGE_CANDIDATES")),
    );

  return {
    isOwner,
    invite,
    permissions: {
      read: canRead,
      manageInvitees: canManageInvitees,
      manageCandidates: canManageCandidates,
      full: hasFull,
    },
    round,
  };
}
