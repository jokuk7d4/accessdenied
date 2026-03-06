import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isInterviewerRoute = createRouteMatcher(["/interviewer(.*)"]);
const isInterviewerAuthRoute = createRouteMatcher([
  "/interviewer/sign-in(.*)",
  "/interviewer/sign-up(.*)",
]);
const isCandidateDashboardRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  const { userId } = await auth();

  if (isInterviewerRoute(req) && !isInterviewerAuthRoute(req)) {
    if (!userId) {
      return NextResponse.redirect(new URL("/interviewer/sign-in", req.url));
    }

    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  }

  if (isCandidateDashboardRoute(req)) {
    if (!userId) {
      return NextResponse.redirect(new URL("/sign-in", req.url));
    }
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
