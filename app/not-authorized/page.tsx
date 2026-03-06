import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotAuthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md border-zinc-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">Not authorized</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-zinc-600">
          <p>You do not have permission to access this page.</p>
          <div className="flex gap-3">
            <Button asChild variant="outline">
              <Link href="/">Go to Home</Link>
            </Button>
            <Button asChild>
              <Link href="/interviewer">Go to Interviewer</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
