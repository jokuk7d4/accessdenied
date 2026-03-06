"use client";

import Link from "next/link";
import { LayoutDashboard, Users } from "lucide-react";
import { usePathname } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type InterviewerSidebarProps = {
  className?: string;
  onNavigate?: () => void;
};

const navItems = [
  {
    label: "Dashboard",
    href: "/interviewer",
    icon: LayoutDashboard,
  },
  {
    label: "Rounds",
    href: "/interviewer",
    icon: Users,
  },
];

const placeholderItems = ["Interview Templates", "Analytics", "Team Settings"];

export function InterviewerSidebar({
  className,
  onNavigate,
}: InterviewerSidebarProps) {
  const pathname = usePathname() ?? "";

  return (
    <div className={cn("flex h-full flex-col bg-white", className)}>
      <div className="px-4 py-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Interviewer
        </p>
        <h2 className="mt-1 text-lg font-semibold">Control Panel</h2>
      </div>

      <Separator />

      <ScrollArea className="flex-1">
        <nav className="space-y-2 p-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              pathname === item.href ||
              (item.href === "/interviewer" && pathname.startsWith("/interviewer/rounds/"));

            return (
              <Link
                key={item.label}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition hover:bg-muted/40",
                  isActive && "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800",
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}

          <div className="pt-4">
            <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
              Coming Soon
            </p>
            <div className="space-y-2">
              {placeholderItems.map((item) => (
                <div
                  key={item}
                  className="flex items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
                >
                  <span>{item}</span>
                  <Badge variant="outline">Soon</Badge>
                </div>
              ))}
            </div>
          </div>
        </nav>
      </ScrollArea>
    </div>
  );
}
