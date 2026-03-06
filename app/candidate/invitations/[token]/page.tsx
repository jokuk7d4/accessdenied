import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { InvitationActions } from "@/app/candidate/invitations/[token]/invitation-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { prisma } from "@/lib/prisma";

type PageProps = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
};

function formatDateTime(value: Date | null) {
  if (!value) {
    return "Yet to be scheduled";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export default async function CandidateInvitationPage({
  params,
  searchParams,
}: PageProps) {
  const { token } = await params;
  const { error } = await searchParams;
  const invitationPath = `/candidate/invitations/${token}`;

  const invite = await prisma.candidateInvite.findUnique({
    where: { token },
    include: {
      round: {
        include: {
          owner: {
            select: {
              email: true,
              name: true,
            },
          },
          schedule: {
            select: {
              startAt: true,
            },
          },
        },
      },
    },
  });

  if (!invite || invite.round.deletedAt) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Invitation not available</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This invitation link is invalid or no longer active.
            </p>
            <Button asChild>
              <Link href="/">Go to home</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const authState = await auth();
  if (!authState.userId) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(invitationPath)}`);
  }

  const signedInUser = await currentUser();
  const signedInEmail =
    signedInUser?.emailAddresses?.[0]?.emailAddress?.trim().toLowerCase() ?? "";
  const inviteEmail = invite.candidateEmail.trim().toLowerCase();
  const hasEmailMismatch = !signedInEmail || signedInEmail !== inviteEmail;

  const candidateSlot = await prisma.roundCandidateSlot.findUnique({
    where: {
      roundId_candidateEmail: {
        roundId: invite.roundId,
        candidateEmail: inviteEmail,
      },
    },
    select: {
      startAt: true,
      endAt: true,
    },
  });

  const isAccepted = invite.status === "ACCEPTED";
  const isClosed = Boolean(invite.round.closedAt);
  const isInactive = invite.status === "EXPIRED" || invite.status === "REVOKED";
  const slotLabel =
    invite.round.conductedBy === "AI" ? "AI Interview Slot" : "Interview Time";

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10">
      <Card className="w-full max-w-2xl">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{invite.round.title}</CardTitle>
            <Badge variant="outline">{invite.round.conductedBy}</Badge>
            {isClosed && <Badge variant="secondary">Closed</Badge>}
            {isAccepted && <Badge>Accepted</Badge>}
            {isInactive && <Badge variant="destructive">Unavailable</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {invite.round.description?.trim() || "No description provided."}
          </p>

          <Separator />

          <div className="space-y-1 rounded-md border p-3 text-sm">
            <p>
              <span className="font-medium">Invitation email:</span> {inviteEmail}
            </p>
            <p>
              <span className="font-medium">Support contact:</span>{" "}
              {invite.round.owner.email ?? invite.round.owner.name ?? "Not available"}
            </p>
            <p>
              <span className="font-medium">{slotLabel}:</span>{" "}
              {candidateSlot
                ? `${formatDateTime(candidateSlot.startAt)} - ${formatDateTime(
                    candidateSlot.endAt,
                  )}`
                : "Yet to be scheduled"}
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {hasEmailMismatch && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">Email mismatch</p>
              <p className="mt-1 text-muted-foreground">
                This invitation is for <span className="font-medium">{inviteEmail}</span>. Sign
                in with that account to continue.
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <InvitationActions
              token={token}
              isAccepted={isAccepted}
              isInactive={isInactive}
              canRespond={!hasEmailMismatch}
            />

            {hasEmailMismatch && (
              <SignOutButton redirectUrl={`/sign-in?redirect_url=${encodeURIComponent(invitationPath)}`}>
                <Button variant="outline">Sign out</Button>
              </SignOutButton>
            )}

            <Button asChild variant="outline">
              <Link href={hasEmailMismatch ? `/sign-in?redirect_url=${encodeURIComponent(invitationPath)}` : "/"}>
                {hasEmailMismatch ? "Try different account" : "Go to home"}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
