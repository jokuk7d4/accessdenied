import { auth, currentUser } from "@clerk/nextjs/server";
import type { Role } from "@/lib/generated/prisma/enums";

import { prisma } from "@/lib/prisma";

export async function syncUser(expectedRole: Role, resolvedUserId?: string | null) {
  const fallbackAuth = resolvedUserId === undefined ? await auth() : null;
  const userId = resolvedUserId ?? fallbackAuth?.userId ?? null;

  if (!userId) {
    return null;
  }

  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses?.[0]?.emailAddress ?? null;
  const fullName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .trim();
  const name = fullName || clerkUser?.username || null;
  const imageUrl = clerkUser?.imageUrl ?? null;

  const user = await prisma.user.upsert({
    where: { clerkUserId: userId },
    create: {
      clerkUserId: userId,
      role: expectedRole,
      email,
      name,
      imageUrl,
    },
    update: {
      role: expectedRole,
      email,
      name,
      imageUrl,
    },
  });

  if (expectedRole === "INTERVIEWER") {
    await prisma.interviewerProfile.createMany({
      data: [{ userId: user.id }],
      skipDuplicates: true,
    });
  }

  if (expectedRole === "CANDIDATE") {
    await prisma.candidateProfile.createMany({
      data: [{ userId: user.id }],
      skipDuplicates: true,
    });
  }

  return user;
}
