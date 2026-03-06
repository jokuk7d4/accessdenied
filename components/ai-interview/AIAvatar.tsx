"use client";

import { Bot } from "lucide-react";

import { cn } from "@/lib/utils";

type AIAvatarProps = {
  speaking: boolean;
  label?: string;
};

export function AIAvatar({ speaking, label = "AI Interviewer" }: AIAvatarProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="relative flex h-52 w-52 items-center justify-center rounded-full border border-sky-500/40 bg-sky-500/10">
        <div
          className={cn(
            "absolute inset-0 rounded-full bg-sky-500/20",
            speaking ? "animate-ping" : "opacity-0",
          )}
        />
        <div
          className={cn(
            "absolute inset-2 rounded-full border border-sky-300/30 transition-transform duration-300",
            speaking ? "scale-110" : "scale-100",
          )}
        />
        <Bot className={cn("h-20 w-20 text-sky-100", speaking ? "animate-pulse" : "opacity-90")} />
      </div>
      <div className="text-center">
        <p className="text-lg font-semibold text-zinc-100">{label}</p>
        <p className="text-sm text-zinc-400">{speaking ? "Speaking..." : "Listening..."}</p>
      </div>
    </div>
  );
}
