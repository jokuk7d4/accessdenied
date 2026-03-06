"use client";

import { UserButton } from "@clerk/nextjs";
import { ArrowLeft, Bell, Menu } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { InterviewerSidebar } from "@/components/interviewer-sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

function getTopbarTitle(pathname: string) {
  if (/^\/interviewer\/rounds\/[^/]+/.test(pathname)) {
    return "Round Details";
  }

  if (pathname === "/interviewer") {
    return "Interviewer Dashboard";
  }

  return "Interviewer Workspace";
}

export function InterviewerTopbar() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const showBackButton = /^\/interviewer\/rounds\/[^/]+/.test(pathname);
  const title = getTopbarTitle(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-white/95 px-3 backdrop-blur md:px-4">
      <div className="flex items-center gap-2">
        <div className="md:hidden">
          <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open sidebar">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="sr-only">Interviewer Navigation</SheetTitle>
              <InterviewerSidebar onNavigate={() => setMobileSidebarOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>

        {showBackButton && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => {
              if (window.history.length > 1) {
                router.back();
                return;
              }
              router.push("/interviewer");
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        )}

        <p className="text-sm font-medium">{title}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Notifications placeholder"
        >
          <Bell className="h-4 w-4" />
        </Button>
        <UserButton />
      </div>
    </header>
  );
}
