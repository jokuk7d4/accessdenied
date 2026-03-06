import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md border-zinc-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl">404 - Page not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-zinc-600">
          <p>The page you requested does not exist or is not accessible.</p>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/">Home</Link>
            </Button>
            <Button asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
