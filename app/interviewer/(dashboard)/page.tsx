import Link from "next/link";
import { redirect } from "next/navigation";

import {
  acceptInvite,
  closeRound,
  declineInvite,
  deleteRound,
} from "@/app/interviewer/actions";
import { CreateRoundDialog } from "@/app/interviewer/components/create-round-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AccessError, requireInterviewer } from "@/lib/roundAccess";
import { prisma } from "@/lib/prisma";

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

async function getInterviewerOrRedirect() {
  try {
    return await requireInterviewer();
  } catch (error) {
    if (error instanceof AccessError && error.status === 401) {
      redirect("/interviewer/sign-in");
    }

    redirect("/not-authorized");
  }
}

export default async function InterviewerDashboardPage() {
  const { user } = await getInterviewerOrRedirect();

  const [ownedRounds, guestRounds, pendingInvites] = await prisma.$transaction([
    prisma.interviewRound.findMany({
      where: { ownerId: user.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        owner: {
          select: {
            name: true,
            email: true,
          },
        },
        _count: {
          select: {
            invites: true,
            candidates: true,
          },
        },
      },
    }),
    prisma.interviewRound.findMany({
      where: {
        deletedAt: null,
        invites: {
          some: {
            inviteeId: user.id,
            status: "ACCEPTED",
          },
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        owner: {
          select: {
            name: true,
            email: true,
          },
        },
        _count: {
          select: {
            invites: true,
            candidates: true,
          },
        },
      },
    }),
    prisma.roundInterviewerInvite.findMany({
      where: {
        inviteeId: user.id,
        status: "PENDING",
        round: {
          deletedAt: null,
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        round: {
          include: {
            owner: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
        inviter: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    }),
  ]);

  return (
    <main className="space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interviewer Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Create rounds, manage interviewer guests, and track candidate lists.
          </p>
        </div>
        <CreateRoundDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pending Invites</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {pendingInvites.length === 0 && (
            <p className="text-sm text-muted-foreground">No pending invites.</p>
          )}

          {pendingInvites.map((invite) => (
            <div key={invite.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{invite.round.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Owner: {invite.round.owner.name ?? invite.round.owner.email ?? "Unknown"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Invited by: {invite.inviter.name ?? invite.inviter.email ?? "Unknown"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <form
                    action={async () => {
                      "use server";
                      await acceptInvite({ inviteId: invite.id });
                    }}
                  >
                    <Button size="sm" type="submit">
                      Accept
                    </Button>
                  </form>
                  <form
                    action={async () => {
                      "use server";
                      await declineInvite({ inviteId: invite.id });
                    }}
                  >
                    <Button size="sm" variant="outline" type="submit">
                      Decline
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Rounds You Own</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {ownedRounds.length === 0 && (
              <p className="text-sm text-muted-foreground">You have not created any rounds yet.</p>
            )}

            {ownedRounds.map((round) => (
              <div key={round.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <Link
                    href={`/interviewer/rounds/${round.id}`}
                    className="block flex-1 rounded-md transition hover:bg-muted/40"
                  >
                    <p className="font-medium">{round.title}</p>
                    <p className="text-xs text-muted-foreground">
                      Created on {formatDate(round.createdAt)}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="outline">{round.conductedBy}</Badge>
                      <Badge variant={round.closedAt ? "secondary" : "default"}>
                        {round.closedAt ? "CLOSED" : "OPEN"}
                      </Badge>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    {!round.closedAt && (
                      <form
                        action={async () => {
                          "use server";
                          await closeRound({ roundId: round.id });
                        }}
                      >
                        <Button size="sm" variant="outline" type="submit">
                          Close
                        </Button>
                      </form>
                    )}
                    <form
                      action={async () => {
                        "use server";
                        await deleteRound({ roundId: round.id });
                      }}
                    >
                      <Button size="sm" variant="destructive" type="submit">
                        Delete
                      </Button>
                    </form>
                  </div>
                </div>
                <Separator className="my-3" />
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span>{round._count.candidates} candidates</span>
                  <span>{round._count.invites} invitees</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Rounds You Joined</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {guestRounds.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No accepted guest rounds yet. Accept an invite to start collaborating.
              </p>
            )}

            {guestRounds.map((round) => (
              <Link
                key={round.id}
                href={`/interviewer/rounds/${round.id}`}
                className="block rounded-md border p-3 transition hover:bg-muted/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{round.title}</p>
                    <p className="text-xs text-muted-foreground">
                      Owner: {round.owner.name ?? round.owner.email ?? "Unknown"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="outline">{round.conductedBy}</Badge>
                      <Badge variant={round.closedAt ? "secondary" : "default"}>
                        {round.closedAt ? "CLOSED" : "OPEN"}
                      </Badge>
                    </div>
                  </div>
                  <Badge variant="secondary">Guest</Badge>
                </div>
                <Separator className="my-3" />
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span>{round._count.candidates} candidates</span>
                  <span>{round._count.invites} invitees</span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
