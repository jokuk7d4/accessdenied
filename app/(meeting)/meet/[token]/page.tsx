import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { AIInterviewPage } from "@/components/ai-interview/AIInterviewPage";
import { MeetingClient } from "./meeting-client";
import { ResumeUploadGate } from "./resume-upload-gate";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { resolveMeetingAccess } from "@/lib/meetingAccess";
import { syncUser } from "@/lib/syncUser";

type PageProps = {
  params: Promise<{ token: string }>;
};

export default async function MeetingPage({ params }: PageProps) {
  const { token } = await params;
  const { userId } = await auth();

  if (!userId) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/meet/${token}`)}`);
  }

  const access = await resolveMeetingAccess(token, userId);

  if (!access.ok) {
    if (access.status === 401) {
      redirect(`/sign-in?redirect_url=${encodeURIComponent(`/meet/${token}`)}`);
    }

    if (access.status === 404) {
      return (
        <main className="fixed inset-0 z-[80] flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-10">
          <Card className="w-full max-w-xl border-zinc-700 bg-zinc-900 text-zinc-100">
            <CardHeader>
              <CardTitle>Meeting not found</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-zinc-300">{access.message}</p>
            </CardContent>
          </Card>
        </main>
      );
    }

    return (
      <main className="fixed inset-0 z-[80] flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-10">
        <Card className="w-full max-w-xl border-zinc-700 bg-zinc-900 text-zinc-100">
          <CardHeader>
            <CardTitle>Unable to join meeting</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-zinc-300">{access.message}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  await syncUser(access.user.role, access.user.clerkUserId);

  const parsedResume =
    access.viewerRole === "CANDIDATE"
      ? await prisma.parsedResume.findUnique({
          where: {
            candidateUserId_roundId: {
              candidateUserId: access.user.id,
              roundId: access.room.roundId,
            },
          },
          select: { id: true },
        })
      : null;

  if (access.viewerRole === "CANDIDATE" && !parsedResume) {
    return (
      <ResumeUploadGate
        meetingToken={token}
        roundTitle={access.room.roundTitle}
        slotStartAt={access.room.slotStartAt.toISOString()}
      />
    );
  }

  if (access.room.roundConductedBy === "AI") {
    if (access.viewerRole !== "CANDIDATE") {
      return (
        <main className="fixed inset-0 z-[80] flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-10">
          <Card className="w-full max-w-xl border-zinc-700 bg-zinc-900 text-zinc-100">
            <CardHeader>
              <CardTitle>AI Interview In Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-zinc-300">
                This AI interview runs autonomously for the candidate. You can review
                transcript, score, and malpractice logs in the interviewer dashboard.
              </p>
            </CardContent>
          </Card>
        </main>
      );
    }

    return (
      <AIInterviewPage meetingRoomId={access.room.id} roundTitle={access.room.roundTitle} />
    );
  }

  return (
    <MeetingClient
      meetingToken={token}
      meetingRoomId={access.room.id}
      roundTitle={access.room.roundTitle}
      roundDescription={access.room.roundDescription}
      slotStartAt={access.room.slotStartAt.toISOString()}
      slotEndAt={access.room.slotEndAt.toISOString()}
      roundOwnerEmail={access.room.roundOwnerEmail}
      viewerRole={access.viewerRole}
      isOwner={access.isOwner}
      canMarkCompleted={access.canMarkCompleted}
      canJoin={access.canJoin}
      joinBlockedReason={access.joinBlockedReason}
      meetingStatus={access.room.status}
      initialMessages={[]}
      meetingEndedAt={access.room.completedAt?.toISOString() ?? null}
    />
  );
}
