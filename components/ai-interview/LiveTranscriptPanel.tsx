"use client";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

type TranscriptItem = {
  id: string;
  speaker: "AI" | "CANDIDATE";
  text: string;
  timestamp: string;
};

type LiveTranscriptPanelProps = {
  transcript: TranscriptItem[];
  liveCandidateText?: string;
  currentQuestion: number;
  maxQuestions: number;
};

export function LiveTranscriptPanel({
  transcript,
  liveCandidateText,
  currentQuestion,
  maxQuestions,
}: LiveTranscriptPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-zinc-800 bg-zinc-950/70">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-100">Live Transcript</h2>
        <Badge variant="secondary">
          Question {Math.min(currentQuestion, maxQuestions)} / {maxQuestions}
        </Badge>
      </div>
      <Separator className="bg-zinc-800" />
      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        <div className="space-y-3">
          {transcript.length === 0 && (
            <p className="text-sm text-zinc-400">Waiting for interview to begin...</p>
          )}

          {transcript.map((item) => (
            <div
              key={item.id}
              className={
                item.speaker === "AI"
                  ? "rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2"
                  : "rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2"
              }
            >
              <p className="mb-1 text-xs font-medium tracking-wide text-zinc-300">
                {item.speaker === "AI" ? "AI" : "Candidate"}
              </p>
              <p className="text-sm text-zinc-100">{item.text}</p>
            </div>
          ))}

          {liveCandidateText?.trim() && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <p className="mb-1 text-xs font-medium tracking-wide text-amber-200">Candidate (live)</p>
              <p className="text-sm text-amber-50">{liveCandidateText.trim()}</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
