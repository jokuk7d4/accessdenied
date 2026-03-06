import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { syncUser } from "@/lib/syncUser";

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export default async function CandidateDashboardPage() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  // Ensure role is synced before reading candidate memberships.
  const user = await syncUser("CANDIDATE", userId);

  if (!user || user.role !== "CANDIDATE") {
    redirect("/not-authorized");
  }

  const memberships = await prisma.candidateRoundMembership.findMany({
    where: {
      userId: user.id,
      round: {
        deletedAt: null,
      },
    },
    include: {
      round: {
        select: {
          id: true,
          title: true,
          description: true,
          conductedBy: true,
          closedAt: true,
          owner: {
            select: {
              email: true,
              name: true,
            },
          },
          schedule: {
            select: {
              id: true,
            },
          },
        },
      },
    },
    orderBy: {
      acceptedAt: "desc",
    },
  });

  const slotRows =
    memberships.length > 0
      ? await prisma.roundCandidateSlot.findMany({
          where: {
            OR: memberships.map((membership) => ({
              roundId: membership.roundId,
              candidateEmail: membership.candidateEmail,
            })),
          },
          select: {
            roundId: true,
            candidateEmail: true,
            startAt: true,
            endAt: true,
            meetingRoom: {
              select: {
                meetingToken: true,
                status: true,
                completedAt: true,
                endedAt: true,
              },
            },
          },
        })
      : [];

  const slotMap = new Map(
    slotRows.map((slot) => [`${slot.roundId}:${slot.candidateEmail}`, slot]),
  );

  return (
    <main className="space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Candidate Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Rounds you accepted through email invitations.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>

      {memberships.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">No rounds yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Accept an invitation email to see your rounds here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {memberships.map((membership) => {
            const key = `${membership.roundId}:${membership.candidateEmail}`;
            const slot = slotMap.get(key);
            const isClosed = Boolean(membership.round.closedAt);
            const meetingCompleted = Boolean(
              slot?.meetingRoom &&
                (slot.meetingRoom.status === "COMPLETED" ||
                  slot.meetingRoom.completedAt ||
                  slot.meetingRoom.endedAt),
            );
            const slotLabel =
              membership.round.conductedBy === "AI"
                ? "AI Interview Slot"
                : "Interview Time";

            return (
              <Card key={membership.id} className={isClosed ? "opacity-70" : undefined}>
                <CardHeader className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-lg">{membership.round.title}</CardTitle>
                    <Badge variant="outline">{membership.round.conductedBy}</Badge>
                    {isClosed && <Badge variant="secondary">Closed</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">
                    {membership.round.description?.trim() || "No description provided."}
                  </p>
                  <p>
                    <span className="font-medium">Support contact:</span>{" "}
                    {membership.round.owner.email ??
                      membership.round.owner.name ??
                      "Not available"}
                  </p>
                  <p>
                    <span className="font-medium">{slotLabel}:</span>{" "}
                    {slot
                      ? `${formatDateTime(slot.startAt)} - ${formatDateTime(slot.endAt)}`
                      : "Yet to be scheduled"}
                  </p>
                  {slot?.meetingRoom?.meetingToken &&
                    (meetingCompleted ? (
                      <Button size="sm" variant="secondary" disabled>
                        {membership.round.conductedBy === "AI"
                          ? "AI Interview Completed"
                          : "Meeting Completed"}
                      </Button>
                    ) : (
                      <Button asChild size="sm">
                        <Link href={`/meet/${slot.meetingRoom.meetingToken}`}>
                          {membership.round.conductedBy === "AI"
                            ? "Start AI Interview"
                            : "Join Meeting"}
                        </Link>
                      </Button>
                    ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
