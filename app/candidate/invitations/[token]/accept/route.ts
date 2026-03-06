import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { acceptCandidateInvitation } from "@/app/candidate/actions";

type RouteContext = {
  params: Promise<{ token: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { token } = await context.params;
  return NextResponse.redirect(
    new URL(`/candidate/invitations/${token}`, request.url),
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  const { userId } = await auth();

  if (!userId) {
    const returnBack = new URL(`/candidate/invitations/${token}`, request.url).toString();
    return NextResponse.redirect(
      new URL(`/sign-in?redirect_url=${encodeURIComponent(returnBack)}`, request.url),
    );
  }

  const result = await acceptCandidateInvitation({ token });

  if (!result.ok) {
    return NextResponse.redirect(
      new URL(
        `/candidate/invitations/${token}?error=${encodeURIComponent(result.error)}`,
        request.url,
      ),
    );
  }

  return NextResponse.redirect(new URL("/dashboard", request.url));
}
