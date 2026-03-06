import { SignIn } from "@clerk/nextjs";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function InterviewerSignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-10">
      <Card className="w-full max-w-md border-zinc-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">Interviewer Sign In</CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <SignIn
            routing="path"
            path="/interviewer/sign-in"
            signUpUrl="/interviewer/sign-up"
            fallbackRedirectUrl="/interviewer"
          />
        </CardContent>
      </Card>
    </div>
  );
}
