"use client";

import { useState, useTransition } from "react";
import { UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

type ResumeUploadGateProps = {
  meetingToken: string;
  roundTitle: string;
  slotStartAt: string;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ResumeUploadGate({
  meetingToken,
  roundTitle,
  slotStartAt,
}: ResumeUploadGateProps) {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <main className="fixed inset-0 z-[80] flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-950 px-4 py-10 text-zinc-100">
      <Card className="w-full max-w-xl border-zinc-700 bg-zinc-900 text-zinc-100">
        <CardHeader className="space-y-2">
          <CardTitle>Upload Resume</CardTitle>
          <p className="text-sm text-zinc-300">
            Please upload your resume before joining <span className="font-medium">{roundTitle}</span>.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-zinc-700 p-3 text-sm">
            <p>
              <span className="font-medium">Interview start:</span>{" "}
              {formatDateTime(slotStartAt)}
            </p>
            <p className="mt-1 text-zinc-400">
              Supported formats: PDF, DOCX. The file is parsed into structured data and not stored.
            </p>
          </div>

          <Separator className="bg-zinc-700" />

          <div className="space-y-3">
            <Input
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
              className="border-zinc-700 bg-zinc-950 text-zinc-100"
              onChange={(event) => {
                setError(null);
                setSelectedFile(event.target.files?.[0] ?? null);
              }}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="button"
              disabled={isPending || !selectedFile}
              onClick={() => {
                startTransition(async () => {
                  if (!selectedFile) {
                    setError("Please select a file.");
                    return;
                  }

                  const preflightResponse = await fetch(
                    "/api/ai/preflight?task=resume-parse",
                    {
                      method: "GET",
                      cache: "no-store",
                    },
                  );
                  const preflightPayload = (await preflightResponse.json()) as {
                    ok?: boolean;
                    error?: string;
                    details?: string;
                    code?: string;
                  };

                  if (!preflightResponse.ok || !preflightPayload.ok) {
                    setError(
                      preflightPayload.error ??
                        "Local AI model is not ready. Please try again in a moment.",
                    );
                    return;
                  }

                  const body = new FormData();
                  body.set("meetingToken", meetingToken);
                  body.set("file", selectedFile);

                  const response = await fetch("/api/resume/parse", {
                    method: "POST",
                    body,
                  });

                  const payload = (await response.json()) as {
                    ok?: boolean;
                    error?: string;
                    message?: string;
                  };

                  if (!response.ok || !payload.ok) {
                    setError(payload.error ?? "Unable to parse resume. Try again.");
                    return;
                  }

                  toast.success(payload.message ?? "Resume uploaded");
                  router.refresh();
                });
              }}
            >
              <UploadCloud className="mr-2 h-4 w-4" />
              {isPending ? "Parsing Resume..." : "Upload and Continue"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
