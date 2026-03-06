"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { sendCandidateInviteEmail } from "@/lib/email";
import { hashMeetingToken } from "@/lib/meeting";
import { AccessError, getRoundAccess, requireInterviewer } from "@/lib/roundAccess";
import { prisma } from "@/lib/prisma";

const permissionSchema = z.enum([
  "READ",
  "MANAGE_INVITEES",
  "MANAGE_CANDIDATES",
  "FULL",
]);

const roundConductedBySchema = z.enum(["AI", "HUMAN"]);

const createRoundInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  description: z.string().trim().max(2000).optional(),
  conductedBy: roundConductedBySchema.default("HUMAN"),
  candidateEmails: z.string().optional(),
  invitees: z
    .array(
      z.object({
        inviteeId: z.string().min(1),
        permission: permissionSchema,
      }),
    )
    .optional(),
});

const inviteDecisionSchema = z.object({
  inviteId: z.string().min(1),
});

const inviteMutationSchema = z.object({
  roundId: z.string().min(1),
  inviteeId: z.string().min(1),
  permission: permissionSchema,
});

const invitePermissionUpdateSchema = z.object({
  roundId: z.string().min(1),
  inviteId: z.string().min(1),
  permission: permissionSchema,
});

const inviteRemoveSchema = z.object({
  roundId: z.string().min(1),
  inviteId: z.string().min(1),
});

const candidateAddSchema = z.object({
  roundId: z.string().min(1),
  candidateEmails: z.string().min(1),
});

const candidateRemoveSchema = z.object({
  roundId: z.string().min(1),
  candidateId: z.string().min(1),
});

const roundMutationSchema = z.object({
  roundId: z.string().min(1),
});

const scheduleRoundSchema = z.object({
  roundId: z.string().min(1),
  startAt: z.string().min(1, "Start date and time is required"),
  minutesPerCandidate: z.coerce
    .number()
    .int("Duration must be a whole number")
    .min(5, "Duration must be at least 5 minutes")
    .max(480, "Duration is too large"),
  workingHoursStart: z.string().trim().optional(),
  workingHoursEnd: z.string().trim().optional(),
  breakStart: z.string().trim().optional(),
  breakEnd: z.string().trim().optional(),
  exceptionalDates: z.string().trim().optional(),
});

const emailSchema = z.string().email();
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

type PermissionKey = "read" | "manageInvitees" | "manageCandidates" | "full";
type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string };

type SlotConfig = {
  startAt: Date;
  minutesPerCandidate: number;
  workingStartMinutes: number | null;
  workingEndMinutes: number | null;
  breakStartMinutes: number | null;
  breakEndMinutes: number | null;
  skipDateKeys: Set<string>;
};

type SlotSeed = {
  candidateEmail: string;
};

type EmailInvite = {
  email: string;
  token: string;
};

function errorMessage(error: unknown): string {
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

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function parseCandidateEmails(rawValue: string): string[] {
  const parts = rawValue
    .split(/[\n,]+/)
    .map((item) => normalizeEmail(item))
    .filter(Boolean);

  const uniqueEmails = Array.from(new Set(parts));
  return uniqueEmails.filter((email) => emailSchema.safeParse(email).success);
}

function getAppBaseUrl(): string {
  const baseUrl =
    process.env.APP_BASE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (!baseUrl) {
    throw new Error("APP_BASE_URL or NEXT_PUBLIC_APP_URL must be configured");
  }

  return baseUrl.replace(/\/+$/, "");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseTimeToMinutes(rawValue: string): number {
  const value = rawValue.trim();

  if (!timePattern.test(value)) {
    throw new AccessError("Time must be in HH:mm format", 400);
  }

  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  return hours * 60 + minutes;
}

function setMinutesForDay(date: Date, minutes: number): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setMinutes(minutes);
  return next;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function nextDay(date: Date): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
}

function parseExceptionalDates(rawValue: string | undefined): Set<string> {
  if (!rawValue) {
    return new Set<string>();
  }

  const values = rawValue
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const output = new Set<string>();

  for (const value of values) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AccessError("Exceptional days must use YYYY-MM-DD format", 400);
    }
    output.add(value);
  }

  return output;
}

function parseScheduleConfig(
  payload: z.infer<typeof scheduleRoundSchema>,
): SlotConfig {
  const startAt = new Date(payload.startAt);

  if (Number.isNaN(startAt.getTime())) {
    throw new AccessError("Invalid start date/time", 400);
  }

  const workingHoursStart = payload.workingHoursStart?.trim() || "";
  const workingHoursEnd = payload.workingHoursEnd?.trim() || "";
  const breakStart = payload.breakStart?.trim() || "";
  const breakEnd = payload.breakEnd?.trim() || "";

  const workingStartMinutes = workingHoursStart
    ? parseTimeToMinutes(workingHoursStart)
    : null;
  const workingEndMinutes = workingHoursEnd
    ? parseTimeToMinutes(workingHoursEnd)
    : null;

  if ((workingStartMinutes === null) !== (workingEndMinutes === null)) {
    throw new AccessError("Provide both working start and end time", 400);
  }

  if (
    workingStartMinutes !== null &&
    workingEndMinutes !== null &&
    workingStartMinutes >= workingEndMinutes
  ) {
    throw new AccessError("Working hours end must be after start", 400);
  }

  const breakStartMinutes = breakStart ? parseTimeToMinutes(breakStart) : null;
  const breakEndMinutes = breakEnd ? parseTimeToMinutes(breakEnd) : null;

  if ((breakStartMinutes === null) !== (breakEndMinutes === null)) {
    throw new AccessError("Provide both break start and break end time", 400);
  }

  if (breakStartMinutes !== null && breakEndMinutes !== null) {
    if (breakStartMinutes >= breakEndMinutes) {
      throw new AccessError("Break end must be after break start", 400);
    }

    if (workingStartMinutes === null || workingEndMinutes === null) {
      throw new AccessError("Break times require working hours", 400);
    }

    if (
      breakStartMinutes < workingStartMinutes ||
      breakEndMinutes > workingEndMinutes
    ) {
      throw new AccessError("Break time must fit inside working hours", 400);
    }
  }

  return {
    startAt,
    minutesPerCandidate: payload.minutesPerCandidate,
    workingStartMinutes,
    workingEndMinutes,
    breakStartMinutes,
    breakEndMinutes,
    skipDateKeys: parseExceptionalDates(payload.exceptionalDates),
  };
}

function ensureValidCursor(cursor: Date, config: SlotConfig): Date {
  let next = new Date(cursor);

  while (true) {
    const key = formatDateKey(next);
    if (config.skipDateKeys.has(key)) {
      next = nextDay(next);
      if (config.workingStartMinutes !== null) {
        next = setMinutesForDay(next, config.workingStartMinutes);
      }
      continue;
    }

    if (
      config.workingStartMinutes !== null &&
      config.workingEndMinutes !== null
    ) {
      const dayStart = setMinutesForDay(next, config.workingStartMinutes);
      const dayEnd = setMinutesForDay(next, config.workingEndMinutes);

      if (next < dayStart) {
        next = dayStart;
        continue;
      }

      if (next >= dayEnd) {
        next = nextDay(next);
        next = setMinutesForDay(next, config.workingStartMinutes);
        continue;
      }

      if (
        config.breakStartMinutes !== null &&
        config.breakEndMinutes !== null
      ) {
        const breakStart = setMinutesForDay(next, config.breakStartMinutes);
        const breakEnd = setMinutesForDay(next, config.breakEndMinutes);

        if (next >= breakStart && next < breakEnd) {
          next = breakEnd;
          continue;
        }
      }
    }

    return next;
  }
}

function buildCandidateSlots(candidates: SlotSeed[], config: SlotConfig) {
  let cursor = new Date(config.startAt);
  const slots: Array<{ candidateEmail: string; startAt: Date; endAt: Date }> = [];

  for (const candidate of candidates) {
    while (true) {
      cursor = ensureValidCursor(cursor, config);

      if (
        config.workingStartMinutes !== null &&
        config.workingEndMinutes !== null
      ) {
        const dayEnd = setMinutesForDay(cursor, config.workingEndMinutes);

        if (
          config.breakStartMinutes !== null &&
          config.breakEndMinutes !== null
        ) {
          const breakStart = setMinutesForDay(cursor, config.breakStartMinutes);
          const breakEnd = setMinutesForDay(cursor, config.breakEndMinutes);
          const proposedEnd = addMinutes(cursor, config.minutesPerCandidate);

          if (cursor < breakStart && proposedEnd > breakStart) {
            cursor = breakEnd;
            continue;
          }
        }

        const endCandidate = addMinutes(cursor, config.minutesPerCandidate);

        if (endCandidate > dayEnd) {
          cursor = nextDay(cursor);
          cursor = setMinutesForDay(cursor, config.workingStartMinutes);
          continue;
        }

        slots.push({
          candidateEmail: candidate.candidateEmail,
          startAt: cursor,
          endAt: endCandidate,
        });
        cursor = endCandidate;
        break;
      }

      const endCandidate = addMinutes(cursor, config.minutesPerCandidate);
      slots.push({
        candidateEmail: candidate.candidateEmail,
        startAt: cursor,
        endAt: endCandidate,
      });
      cursor = endCandidate;
      break;
    }
  }

  return slots;
}

async function requirePermission(
  roundId: string,
  clerkUserId: string,
  permission: PermissionKey,
) {
  const access = await getRoundAccess(roundId, clerkUserId);

  if (!access || !access.permissions.read) {
    throw new AccessError("You don't have access to this round", 403);
  }

  if (!access.permissions[permission]) {
    throw new AccessError("You don't have permission for this action", 403);
  }

  return access;
}

function ensureRoundOpen(access: Awaited<ReturnType<typeof requirePermission>>) {
  if (access.round.closedAt) {
    throw new AccessError("Round is closed and read-only", 400);
  }
}

async function sendCandidateInvites(
  invites: EmailInvite[],
  round: { title: string; description: string | null },
  ownerEmail: string | null,
): Promise<{ sent: number; failed: number }> {
  if (invites.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const baseUrl = getAppBaseUrl();
  let sent = 0;
  let failed = 0;

  await Promise.all(
    invites.map(async (invite) => {
      try {
        await sendCandidateInviteEmail({
          toEmail: invite.email,
          roundTitle: round.title,
          roundDescription: round.description,
          ownerEmail,
          acceptUrl: `${baseUrl}/candidate/invitations/${invite.token}`,
        });
        sent += 1;
      } catch {
        failed += 1;
      }
    }),
  );

  return { sent, failed };
}

export async function createRound(
  input: z.infer<typeof createRoundInputSchema>,
): Promise<ActionResult<{ roundId: string }>> {
  try {
    const { user } = await requireInterviewer();
    const parsed = createRoundInputSchema.parse(input);

    const title = parsed.title.trim();
    const description = parsed.description?.trim() || null;
    const conductedBy = parsed.conductedBy;
    const candidateEmails = parseCandidateEmails(parsed.candidateEmails ?? "");
    const inviteMap = new Map<string, z.infer<typeof permissionSchema>>();

    for (const invite of parsed.invitees ?? []) {
      if (invite.inviteeId !== user.id) {
        inviteMap.set(invite.inviteeId, invite.permission);
      }
    }

    const inviteeIds = Array.from(inviteMap.keys());
    const invitees = inviteeIds.length
      ? await prisma.user.findMany({
          where: {
            id: { in: inviteeIds },
            role: "INTERVIEWER",
          },
          select: { id: true },
        })
      : [];

    const validInviteeIds = new Set(invitees.map((invitee) => invitee.id));

    const roundResult = await prisma.$transaction(async (tx) => {
      const createdRound = await tx.interviewRound.create({
        data: {
          title,
          description,
          ownerId: user.id,
          conductedBy,
        },
      });

      if (candidateEmails.length > 0) {
        await tx.roundCandidate.createMany({
          data: candidateEmails.map((email) => ({
            roundId: createdRound.id,
            email,
          })),
          skipDuplicates: true,
        });
      }

      if (validInviteeIds.size > 0) {
        await tx.roundInterviewerInvite.createMany({
          data: Array.from(validInviteeIds).map((inviteeId) => ({
            roundId: createdRound.id,
            inviterId: user.id,
            inviteeId,
            status: "PENDING",
            permissions: [inviteMap.get(inviteeId) ?? "READ"],
          })),
        });
      }

      return { round: createdRound };
    });

    revalidatePath("/interviewer");

    return {
      ok: true,
      data: { roundId: roundResult.round.id },
      message:
        "Round created successfully. Candidate invitations will be emailed after scheduling.",
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function closeRound(
  payload: z.infer<typeof roundMutationSchema>,
): Promise<ActionResult> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const { roundId } = roundMutationSchema.parse(payload);
    const access = await getRoundAccess(roundId, clerkUserId);

    if (!access) {
      throw new AccessError("Round not found", 404);
    }

    if (!access.isOwner) {
      throw new AccessError("Only the owner can close this round", 403);
    }

    if (access.round.closedAt) {
      return { ok: true, message: "Round is already closed" };
    }

    await prisma.interviewRound.update({
      where: { id: roundId },
      data: { closedAt: new Date() },
    });

    revalidatePath("/interviewer");
    revalidatePath(`/interviewer/rounds/${roundId}`);
    revalidatePath("/dashboard");

    return { ok: true, message: "Round closed" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function deleteRound(
  payload: z.infer<typeof roundMutationSchema>,
): Promise<ActionResult> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const { roundId } = roundMutationSchema.parse(payload);
    const access = await getRoundAccess(roundId, clerkUserId);

    if (!access) {
      throw new AccessError("Round not found", 404);
    }

    if (!access.isOwner) {
      throw new AccessError("Only the owner can delete this round", 403);
    }

    if (access.round.deletedAt) {
      return { ok: true, message: "Round already deleted" };
    }

    await prisma.interviewRound.update({
      where: { id: roundId },
      data: {
        deletedAt: new Date(),
        closedAt: access.round.closedAt ?? new Date(),
      },
    });

    revalidatePath("/interviewer");
    revalidatePath(`/interviewer/rounds/${roundId}`);
    revalidatePath("/dashboard");

    return { ok: true, message: "Round deleted" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function scheduleRound(
  payload: z.infer<typeof scheduleRoundSchema>,
): Promise<ActionResult<{ slots: number }>> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const parsed = scheduleRoundSchema.parse(payload);
    const access = await getRoundAccess(parsed.roundId, clerkUserId);

    if (!access || !access.permissions.read) {
      throw new AccessError("Round not found", 404);
    }

    if (!(access.isOwner || access.permissions.full)) {
      throw new AccessError("Only owner or FULL guests can schedule", 403);
    }

    ensureRoundOpen(access);

    const round = await prisma.interviewRound.findUnique({
      where: { id: parsed.roundId },
      select: {
        id: true,
        title: true,
        description: true,
        conductedBy: true,
        owner: {
          select: {
            email: true,
          },
        },
        schedulingLocked: true,
        schedule: {
          select: { id: true },
        },
        candidates: {
          where: {},
          orderBy: { createdAt: "asc" },
          select: {
            email: true,
          },
        },
      },
    });

    if (!round) {
      throw new AccessError("Round not found", 404);
    }

    if (round.schedulingLocked || round.schedule) {
      throw new AccessError("Round is already scheduled and candidate list is locked", 400);
    }

    if (round.candidates.length === 0) {
      throw new AccessError("Add candidates before scheduling", 400);
    }

    const config = parseScheduleConfig(parsed);
    const slots = buildCandidateSlots(
      round.candidates.map((candidate) => ({
        candidateEmail: candidate.email,
      })),
      config,
    );

    const invitesToSend: EmailInvite[] = [];

    await prisma.$transaction(async (tx) => {
      await tx.roundSchedule.create({
        data: {
          roundId: round.id,
          startAt: config.startAt,
          minutesPerCandidate: config.minutesPerCandidate,
          workingHoursStart: parsed.workingHoursStart?.trim() || null,
          workingHoursEnd: parsed.workingHoursEnd?.trim() || null,
          breakStart: parsed.breakStart?.trim() || null,
          breakEnd: parsed.breakEnd?.trim() || null,
          skipDates: Array.from(config.skipDateKeys),
        },
      });

      await tx.roundCandidateSlot.deleteMany({
        where: { roundId: round.id },
      });

      await tx.roundCandidateSlot.createMany({
        data: slots.map((slot) => ({
          roundId: round.id,
          candidateEmail: slot.candidateEmail,
          startAt: slot.startAt,
          endAt: slot.endAt,
        })),
      });

      const createdSlots = await tx.roundCandidateSlot.findMany({
        where: {
          roundId: round.id,
          candidateEmail: {
            in: slots.map((slot) => slot.candidateEmail),
          },
        },
        select: {
          id: true,
        },
      });

      for (const slot of createdSlots) {
        const meetingToken = generateToken();
        await tx.meetingRoom.upsert({
          where: { slotId: slot.id },
          create: {
            roundId: round.id,
            slotId: slot.id,
            meetingToken,
            meetingTokenHash: hashMeetingToken(meetingToken),
            status: "SCHEDULED",
            joinCount: 0,
            completedAt: null,
            completedByUserId: null,
          },
          update: {
            meetingToken,
            meetingTokenHash: hashMeetingToken(meetingToken),
            status: "SCHEDULED",
            joinCount: 0,
            completedAt: null,
            completedByUserId: null,
            endedAt: null,
            endedByUserId: null,
          },
        });
      }

      const existingInvites = await tx.candidateInvite.findMany({
        where: {
          roundId: round.id,
          candidateEmail: {
            in: round.candidates.map((candidate) => candidate.email),
          },
        },
        select: {
          id: true,
          candidateEmail: true,
          status: true,
        },
      });

      const existingInviteByEmail = new Map(
        existingInvites.map((invite) => [invite.candidateEmail, invite]),
      );

      for (const candidate of round.candidates) {
        const email = candidate.email;
        const existingInvite = existingInviteByEmail.get(email);

        if (existingInvite?.status === "ACCEPTED") {
          continue;
        }

        const token = generateToken();
        invitesToSend.push({ email, token });

        if (existingInvite) {
          await tx.candidateInvite.update({
            where: { id: existingInvite.id },
            data: {
              token,
              status: "SENT",
              sentAt: new Date(),
              acceptedAt: null,
              acceptedByUserId: null,
            },
          });
        } else {
          await tx.candidateInvite.create({
            data: {
              roundId: round.id,
              candidateEmail: email,
              token,
              status: "SENT",
              sentAt: new Date(),
            },
          });
        }
      }

      await tx.interviewRound.update({
        where: { id: round.id },
        data: { schedulingLocked: true },
      });
    });

    const emailResult = await sendCandidateInvites(
      invitesToSend,
      { title: round.title, description: round.description },
      round.owner.email ?? null,
    );

    revalidatePath(`/interviewer/rounds/${round.id}`);
    revalidatePath("/interviewer");
    revalidatePath("/dashboard");

    const slotMessage =
      round.conductedBy === "AI"
        ? "AI interview slots generated and candidate list locked"
        : "Interview schedule generated and candidate list locked";

    const inviteMessage =
      emailResult.failed > 0
        ? ` ${emailResult.sent} invite email(s) sent, ${emailResult.failed} failed.`
        : ` ${emailResult.sent} invite email(s) sent.`;

    return {
      ok: true,
      data: { slots: slots.length },
      message: `${slotMessage}.${inviteMessage}`,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function acceptInvite(
  payload: z.infer<typeof inviteDecisionSchema>,
): Promise<ActionResult> {
  try {
    const { user } = await requireInterviewer();
    const { inviteId } = inviteDecisionSchema.parse(payload);

    const invite = await prisma.roundInterviewerInvite.findUnique({
      where: { id: inviteId },
      select: {
        id: true,
        inviteeId: true,
        roundId: true,
        status: true,
        round: {
          select: {
            deletedAt: true,
          },
        },
      },
    });

    if (!invite || invite.inviteeId !== user.id || invite.round.deletedAt) {
      throw new AccessError("Invite not found", 404);
    }

    if (invite.status !== "PENDING") {
      throw new AccessError("Invite is no longer pending", 400);
    }

    await prisma.roundInterviewerInvite.update({
      where: { id: inviteId },
      data: { status: "ACCEPTED" },
    });

    revalidatePath("/interviewer");
    revalidatePath(`/interviewer/rounds/${invite.roundId}`);

    return { ok: true, message: "Invite accepted" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function declineInvite(
  payload: z.infer<typeof inviteDecisionSchema>,
): Promise<ActionResult> {
  try {
    const { user } = await requireInterviewer();
    const { inviteId } = inviteDecisionSchema.parse(payload);

    const invite = await prisma.roundInterviewerInvite.findUnique({
      where: { id: inviteId },
      select: {
        id: true,
        inviteeId: true,
        roundId: true,
        status: true,
        round: {
          select: {
            deletedAt: true,
          },
        },
      },
    });

    if (!invite || invite.inviteeId !== user.id || invite.round.deletedAt) {
      throw new AccessError("Invite not found", 404);
    }

    if (invite.status !== "PENDING") {
      throw new AccessError("Invite is no longer pending", 400);
    }

    await prisma.roundInterviewerInvite.update({
      where: { id: inviteId },
      data: { status: "DECLINED" },
    });

    revalidatePath("/interviewer");
    revalidatePath(`/interviewer/rounds/${invite.roundId}`);

    return { ok: true, message: "Invite declined" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function addInvitee(
  payload: z.infer<typeof inviteMutationSchema>,
): Promise<ActionResult> {
  try {
    const { clerkUserId, user } = await requireInterviewer();
    const { roundId, inviteeId, permission } = inviteMutationSchema.parse(payload);
    const access = await requirePermission(roundId, clerkUserId, "manageInvitees");
    ensureRoundOpen(access);

    const [round, invitee] = await prisma.$transaction([
      prisma.interviewRound.findUnique({
        where: { id: roundId },
        select: { ownerId: true, deletedAt: true },
      }),
      prisma.user.findUnique({
        where: { id: inviteeId },
        select: { id: true, role: true },
      }),
    ]);

    if (!round || round.deletedAt) {
      throw new AccessError("Round not found", 404);
    }

    if (!invitee || invitee.role !== "INTERVIEWER") {
      throw new AccessError("Invitee must be an interviewer with an account", 400);
    }

    if (invitee.id === round.ownerId) {
      throw new AccessError("Round owner cannot be invited", 400);
    }

    await prisma.roundInterviewerInvite.upsert({
      where: {
        roundId_inviteeId: {
          roundId,
          inviteeId,
        },
      },
      create: {
        roundId,
        inviterId: user.id,
        inviteeId,
        status: "PENDING",
        permissions: [permission],
      },
      update: {
        inviterId: user.id,
        status: "PENDING",
        permissions: [permission],
      },
    });

    revalidatePath(`/interviewer/rounds/${roundId}`);
    revalidatePath("/interviewer");

    return { ok: true, message: "Invite sent" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function updateInvitePermission(
  payload: z.infer<typeof invitePermissionUpdateSchema>,
): Promise<ActionResult> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const { roundId, inviteId, permission } = invitePermissionUpdateSchema.parse(payload);
    const access = await requirePermission(roundId, clerkUserId, "manageInvitees");
    ensureRoundOpen(access);

    const invite = await prisma.roundInterviewerInvite.findUnique({
      where: { id: inviteId },
      select: { id: true, roundId: true },
    });

    if (!invite || invite.roundId !== roundId) {
      throw new AccessError("Invite not found", 404);
    }

    await prisma.roundInterviewerInvite.update({
      where: { id: inviteId },
      data: { permissions: [permission] },
    });

    revalidatePath(`/interviewer/rounds/${roundId}`);

    return { ok: true, message: "Permissions updated" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function removeInvitee(
  payload: z.infer<typeof inviteRemoveSchema>,
): Promise<ActionResult> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const { roundId, inviteId } = inviteRemoveSchema.parse(payload);
    const access = await requirePermission(roundId, clerkUserId, "manageInvitees");
    ensureRoundOpen(access);

    const invite = await prisma.roundInterviewerInvite.findUnique({
      where: { id: inviteId },
      select: { id: true, roundId: true },
    });

    if (!invite || invite.roundId !== roundId) {
      throw new AccessError("Invite not found", 404);
    }

    await prisma.roundInterviewerInvite.update({
      where: { id: inviteId },
      data: { status: "REVOKED" },
    });

    revalidatePath(`/interviewer/rounds/${roundId}`);
    revalidatePath("/interviewer");

    return { ok: true, message: "Invite revoked" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function addCandidates(
  payload: z.infer<typeof candidateAddSchema>,
): Promise<ActionResult<{ inserted: number; emailsSent: number; emailFailures: number }>> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const { roundId, candidateEmails } = candidateAddSchema.parse(payload);
    const access = await requirePermission(roundId, clerkUserId, "manageCandidates");
    ensureRoundOpen(access);

    if (!(access.isOwner || access.permissions.full)) {
      throw new AccessError(
        "Only owner or FULL-permission guests can add candidates",
        403,
      );
    }

    if (access.round.schedulingLocked) {
      throw new AccessError("Candidates are locked after scheduling", 400);
    }

    const parsedEmails = parseCandidateEmails(candidateEmails);

    if (parsedEmails.length === 0) {
      throw new AccessError("Provide at least one valid candidate email", 400);
    }

    const round = await prisma.interviewRound.findUnique({
      where: { id: roundId },
      select: { id: true, deletedAt: true },
    });

    if (!round || round.deletedAt) {
      throw new AccessError("Round not found", 404);
    }

    const insertedCount = await prisma.$transaction(async (tx) => {
      const existingCandidates = await tx.roundCandidate.findMany({
        where: {
          roundId,
          email: { in: parsedEmails },
        },
        select: { email: true },
      });

      const existingEmails = new Set(existingCandidates.map((candidate) => candidate.email));
      const newEmails = parsedEmails.filter((email) => !existingEmails.has(email));

      if (newEmails.length === 0) {
        return 0;
      }

      const createResult = await tx.roundCandidate.createMany({
        data: newEmails.map((email) => ({
          roundId,
          email,
        })),
        skipDuplicates: true,
      });

      return createResult.count;
    });

    revalidatePath(`/interviewer/rounds/${roundId}`);

    return {
      ok: true,
      data: {
        inserted: insertedCount,
        emailsSent: 0,
        emailFailures: 0,
      },
      message: "Candidates added. Invitations will be sent after schedule generation.",
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function removeCandidate(
  payload: z.infer<typeof candidateRemoveSchema>,
): Promise<ActionResult> {
  try {
    const { clerkUserId } = await requireInterviewer();
    const { roundId, candidateId } = candidateRemoveSchema.parse(payload);
    const access = await requirePermission(roundId, clerkUserId, "manageCandidates");
    ensureRoundOpen(access);

    if (access.round.schedulingLocked) {
      throw new AccessError("Candidates are locked after scheduling", 400);
    }

    const candidate = await prisma.roundCandidate.findFirst({
      where: {
        id: candidateId,
        roundId,
      },
      select: {
        id: true,
        email: true,
      },
    });

    if (!candidate) {
      throw new AccessError("Candidate not found", 404);
    }

    await prisma.$transaction(async (tx) => {
      await tx.roundCandidate.delete({
        where: {
          id: candidate.id,
        },
      });

      await tx.roundCandidateSlot.deleteMany({
        where: {
          roundId,
          candidateEmail: candidate.email,
        },
      });

      await tx.candidateRoundMembership.deleteMany({
        where: {
          roundId,
          candidateEmail: candidate.email,
        },
      });

      await tx.candidateInvite.updateMany({
        where: {
          roundId,
          candidateEmail: candidate.email,
        },
        data: {
          status: "REVOKED",
        },
      });
    });

    revalidatePath(`/interviewer/rounds/${roundId}`);
    revalidatePath("/dashboard");

    return { ok: true, message: "Candidate removed" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
