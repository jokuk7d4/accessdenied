"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  acceptCandidateInvitation,
  declineCandidateInvitation,
} from "@/app/candidate/actions";
import { Button } from "@/components/ui/button";

type InvitationActionsProps = {
  token: string;
  canRespond: boolean;
  isAccepted: boolean;
  isInactive: boolean;
};

export function InvitationActions({
  token,
  canRespond,
  isAccepted,
  isInactive,
}: InvitationActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!canRespond) {
    return (
      <Button asChild>
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    );
  }

  if (isAccepted || isInactive) {
    return (
      <Button asChild>
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const result = await acceptCandidateInvitation({ token });

            if (!result.ok) {
              toast.error(result.error);
              return;
            }

            toast.success(result.message ?? "Invitation accepted");
            router.push("/dashboard");
          });
        }}
      >
        {pending ? "Accepting..." : "Accept invitation"}
      </Button>

      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const result = await declineCandidateInvitation({ token });

            if (!result.ok) {
              toast.error(result.error);
              return;
            }

            toast.success(result.message ?? "Invitation declined");
            router.refresh();
          });
        }}
      >
        {pending ? "Updating..." : "Decline"}
      </Button>
    </>
  );
}
