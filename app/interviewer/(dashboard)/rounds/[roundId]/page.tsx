import { redirect } from "next/navigation";

import { RoundDetailClient } from "@/app/interviewer/components/round-detail-client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessError, getRoundAccess, requireInterviewer } from "@/lib/roundAccess";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ roundId: string }>;
};

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function requireInterviewerOrRedirect() {
  try {
    return await requireInterviewer();
  } catch (error) {
    if (error instanceof AccessError && error.status === 401) {
      redirect("/interviewer/sign-in");
    }

    redirect("/not-authorized");
  }
}

export default async function RoundDetailPage({ params }: PageProps) {
  const { roundId } = await params;
  const { clerkUserId } = await requireInterviewerOrRedirect();
  const access = await getRoundAccess(roundId, clerkUserId);

  if (!access || !access.permissions.read) {
    redirect("/not-authorized");
  }

  const round = await prisma.interviewRound.findUnique({
    where: { id: roundId },
    include: {
      owner: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      schedule: true,
      slots: {
        include: {
          meetingRoom: {
            select: {
              meetingToken: true,
              status: true,
              completedAt: true,
              endedAt: true,
            },
          },
        },
        orderBy: { startAt: "asc" },
      },
      invites: {
        include: {
          invitee: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          inviter: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
      candidates: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!round) {
    redirect("/interviewer");
  }

  let aiSessions: Array<{
    id: string;
    status: "IN_PROGRESS" | "COMPLETED";
    finalScore: number | null;
    aiScore: number | null;
    summary: string | null;
    strengths: string[];
    weaknesses: string[];
    malpracticePenalty: number;
    candidateUser: {
      id: string;
      name: string | null;
      email: string | null;
    };
    meetingRoom: {
      slot: {
        candidateEmail: string;
        startAt: Date;
        endAt: Date;
      };
    };
    proctoringEvents: Array<{
      id: string;
      type: string;
      durationSec: number;
      occurredAt: Date;
    }>;
    transcriptTurns: Array<{
      id: string;
      speaker: "AI" | "CANDIDATE";
      text: string;
      createdAt: Date;
    }>;
  }> = [];

  if (round.conductedBy === "AI") {
    try {
      aiSessions = await prisma.aiInterviewSession.findMany({
        where: {
          roundId: round.id,
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          candidateUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          meetingRoom: {
            select: {
              slot: {
                select: {
                  candidateEmail: true,
                  startAt: true,
                  endAt: true,
                },
              },
            },
          },
          proctoringEvents: {
            orderBy: {
              occurredAt: "asc",
            },
            select: {
              id: true,
              type: true,
              durationSec: true,
              occurredAt: true,
            },
          },
          transcriptTurns: {
            orderBy: {
              createdAt: "asc",
            },
            select: {
              id: true,
              speaker: true,
              text: true,
              createdAt: true,
            },
          },
        },
      });
    } catch (error) {
      const isMissingTableError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2021";

      if (!isMissingTableError) {
        throw error;
      }
    }
  }

  return (
    <main className="space-y-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{round.title}</h1>
        <p className="text-sm text-muted-foreground">
          Created on {formatDate(round.createdAt)} by{" "}
          {round.owner.name ?? round.owner.email ?? "Unknown"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Round Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {round.description?.trim() || "No description provided."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge>{access.isOwner ? "Owner" : "Guest"}</Badge>
            <Badge variant="outline">{round.conductedBy}</Badge>
            <Badge variant={round.closedAt ? "secondary" : "default"}>
              {round.closedAt ? "Closed" : "Open"}
            </Badge>
            {round.schedulingLocked && <Badge>Candidate list locked</Badge>}
            {access.permissions.full && <Badge variant="secondary">Full access</Badge>}
            {access.permissions.manageInvitees && (
              <Badge variant="outline">Can manage invitees</Badge>
            )}
            {access.permissions.manageCandidates && (
              <Badge variant="outline">Can manage candidates</Badge>
            )}
            {!access.permissions.manageInvitees && !access.permissions.manageCandidates && (
              <Badge variant="outline">Read only</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <RoundDetailClient
        roundId={round.id}
        roundConductedBy={round.conductedBy}
        isClosed={Boolean(round.closedAt)}
        schedulingLocked={round.schedulingLocked}
        schedule={
          round.schedule
            ? {
                id: round.schedule.id,
                startAt: round.schedule.startAt.toISOString(),
                minutesPerCandidate: round.schedule.minutesPerCandidate,
                workingHoursStart: round.schedule.workingHoursStart,
                workingHoursEnd: round.schedule.workingHoursEnd,
                breakStart: round.schedule.breakStart,
                breakEnd: round.schedule.breakEnd,
                skipDates: round.schedule.skipDates,
              }
            : null
        }
        slots={round.slots.map((slot) => ({
          id: slot.id,
          candidateEmail: slot.candidateEmail,
          startAt: slot.startAt.toISOString(),
          endAt: slot.endAt.toISOString(),
          meetingToken: slot.meetingRoom?.meetingToken ?? null,
          meetingStatus: slot.meetingRoom?.status ?? null,
          completedAt: slot.meetingRoom?.completedAt?.toISOString() ?? null,
          endedAt: slot.meetingRoom?.endedAt?.toISOString() ?? null,
        }))}
        canManageInvitees={access.permissions.manageInvitees}
        canManageCandidates={access.permissions.manageCandidates}
        canSchedule={access.isOwner || access.permissions.full}
        invitees={round.invites.map((invite) => ({
          id: invite.id,
          status: invite.status,
          permissions: invite.permissions,
          createdAt: invite.createdAt.toISOString(),
          invitee: invite.invitee,
          inviter: invite.inviter,
        }))}
        candidates={round.candidates.map((candidate) => ({
          id: candidate.id,
          email: candidate.email,
          name: candidate.name,
          createdAt: candidate.createdAt.toISOString(),
        }))}
      />

      {round.conductedBy === "AI" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">AI Interview Evaluations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {aiSessions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No AI interview sessions have been recorded yet.
              </p>
            )}

            {aiSessions.map((session) => (
              <div key={session.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {session.candidateUser.name ??
                        session.candidateUser.email ??
                        session.meetingRoom.slot.candidateEmail}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Slot: {formatDateTime(session.meetingRoom.slot.startAt)} -{" "}
                      {formatDateTime(session.meetingRoom.slot.endAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{session.status}</Badge>
                    {session.finalScore !== null && (
                      <Badge>Final Score: {session.finalScore}</Badge>
                    )}
                    {session.aiScore !== null && (
                      <Badge variant="secondary">AI Score: {session.aiScore}</Badge>
                    )}
                  </div>
                </div>

                {session.summary && (
                  <p className="mt-3 text-sm text-muted-foreground">{session.summary}</p>
                )}

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-sm font-medium">Strengths</p>
                    {session.strengths.length === 0 ? (
                      <p className="text-sm text-muted-foreground">-</p>
                    ) : (
                      <ul className="mt-1 list-disc pl-4 text-sm text-muted-foreground">
                        {session.strengths.map((item, index) => (
                          <li key={`${session.id}-strength-${index}`}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium">Weaknesses</p>
                    {session.weaknesses.length === 0 ? (
                      <p className="text-sm text-muted-foreground">-</p>
                    ) : (
                      <ul className="mt-1 list-disc pl-4 text-sm text-muted-foreground">
                        {session.weaknesses.map((item, index) => (
                          <li key={`${session.id}-weakness-${index}`}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  <p className="text-sm font-medium">
                    Malpractice Flags ({session.proctoringEvents.length})
                  </p>
                  {session.proctoringEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No violations logged.</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {session.proctoringEvents.map((event) => (
                        <Badge key={event.id} variant="outline">
                          {event.type} ({event.durationSec}s)
                        </Badge>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Penalty applied: -{session.malpracticePenalty}
                  </p>
                </div>

                <div className="mt-4">
                  <p className="text-sm font-medium">Transcript</p>
                  {session.transcriptTurns.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No transcript turns recorded.</p>
                  ) : (
                    <div className="mt-2 max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
                      {session.transcriptTurns.map((turn) => (
                        <div key={turn.id} className="text-sm">
                          <span className="font-medium">
                            {turn.speaker === "AI" ? "AI" : "Candidate"}:
                          </span>{" "}
                          <span className="text-muted-foreground">{turn.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
