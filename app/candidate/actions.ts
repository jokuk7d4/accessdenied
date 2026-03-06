"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AccessError } from "@/lib/roundAccess";
import { prisma } from "@/lib/prisma";
import { syncUser } from "@/lib/syncUser";

const acceptInviteSchema = z.object({
  token: z.string().trim().min(1),
});

const declineInviteSchema = z.object({
  token: z.string().trim().min(1),
});

type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string };

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function errorMessage(error: unknown) {
  if (error instanceof AccessError) {
    return error.message;
  }

  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid input";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong";
}

async function resolveCandidateAuthContext() {
  const { userId } = await auth();

  if (!userId) {
    throw new AccessError("Please sign in to continue", 401);
  }

  const candidateUser = await syncUser("CANDIDATE", userId);

  if (!candidateUser) {
    throw new AccessError("Unable to resolve your account", 401);
  }

  const clerkUser = await currentUser();
  const emailFromClerk = clerkUser?.emailAddresses?.[0]?.emailAddress ?? null;
  const candidateEmail = normalizeEmail(candidateUser.email ?? emailFromClerk ?? "");

  if (!candidateEmail) {
    throw new AccessError("No email found on your account", 400);
  }

  return { candidateUser, candidateEmail };
}

async function loadInviteByToken(token: string) {
  const invite = await prisma.candidateInvite.findUnique({
    where: { token },
    select: {
      id: true,
      roundId: true,
      candidateEmail: true,
      status: true,
      acceptedByUserId: true,
      round: {
        select: {
          deletedAt: true,
        },
      },
    },
  });

  if (!invite || invite.round.deletedAt) {
    throw new AccessError("Invitation is invalid or no longer available", 404);
  }

  return invite;
}

export async function acceptCandidateInvitation(
  payload: z.infer<typeof acceptInviteSchema>,
): Promise<ActionResult<{ roundId: string }>> {
  try {
    const { token } = acceptInviteSchema.parse(payload);
    const { candidateUser, candidateEmail } = await resolveCandidateAuthContext();
    const invite = await loadInviteByToken(token);

    const inviteEmail = normalizeEmail(invite.candidateEmail);

    if (inviteEmail !== candidateEmail) {
      throw new AccessError(
        `This invitation is for ${inviteEmail}. Sign in with that email to continue.`,
        403,
      );
    }

    if (invite.status === "EXPIRED" || invite.status === "REVOKED") {
      throw new AccessError("This invitation is no longer active", 400);
    }

    if (
      invite.acceptedByUserId &&
      invite.acceptedByUserId !== candidateUser.id
    ) {
      throw new AccessError("This invitation is already accepted by another account", 403);
    }

    const membershipByEmail = await prisma.candidateRoundMembership.findUnique({
      where: {
        roundId_candidateEmail: {
          roundId: invite.roundId,
          candidateEmail: inviteEmail,
        },
      },
      select: {
        userId: true,
      },
    });

    if (membershipByEmail && membershipByEmail.userId !== candidateUser.id) {
      throw new AccessError("This invitation is already accepted by another account", 403);
    }

    await prisma.$transaction(async (tx) => {
      if (invite.status !== "ACCEPTED") {
        await tx.candidateInvite.update({
          where: { id: invite.id },
          data: {
            status: "ACCEPTED",
            acceptedAt: new Date(),
            acceptedByUserId: candidateUser.id,
          },
        });
      }

      await tx.candidateRoundMembership.upsert({
        where: {
          roundId_userId: {
            roundId: invite.roundId,
            userId: candidateUser.id,
          },
        },
        create: {
          roundId: invite.roundId,
          userId: candidateUser.id,
          candidateEmail: inviteEmail,
          inviteId: invite.id,
          acceptedAt: new Date(),
        },
        update: {
          candidateEmail: inviteEmail,
          inviteId: invite.id,
          acceptedAt: new Date(),
        },
      });
    });

    revalidatePath("/dashboard");
    revalidatePath(`/interviewer/rounds/${invite.roundId}`);

    return {
      ok: true,
      data: { roundId: invite.roundId },
      message: "Invitation accepted",
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function declineCandidateInvitation(
  payload: z.infer<typeof declineInviteSchema>,
): Promise<ActionResult<{ roundId: string }>> {
  try {
    const { token } = declineInviteSchema.parse(payload);
    const { candidateEmail } = await resolveCandidateAuthContext();
    const invite = await loadInviteByToken(token);
    const inviteEmail = normalizeEmail(invite.candidateEmail);

    if (inviteEmail !== candidateEmail) {
      throw new AccessError(
        `This invitation is for ${inviteEmail}. Sign in with that email to continue.`,
        403,
      );
    }

    if (invite.status === "ACCEPTED") {
      return {
        ok: true,
        data: { roundId: invite.roundId },
        message: "Invitation already accepted",
      };
    }

    if (invite.status === "EXPIRED" || invite.status === "REVOKED") {
      return {
        ok: true,
        data: { roundId: invite.roundId },
        message: "Invitation already inactive",
      };
    }

    await prisma.candidateInvite.update({
      where: { id: invite.id },
      data: { status: "REVOKED" },
    });

    revalidatePath(`/candidate/invitations/${token}`);
    revalidatePath("/dashboard");

    return {
      ok: true,
      data: { roundId: invite.roundId },
      message: "Invitation declined",
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
