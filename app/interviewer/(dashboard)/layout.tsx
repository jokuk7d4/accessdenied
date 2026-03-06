import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { InterviewerSidebar } from "@/components/interviewer-sidebar";
import { InterviewerTopbar } from "@/components/interviewer-topbar";
import { syncUser } from "@/lib/syncUser";

type Props = {
  children: React.ReactNode;
};

export default async function InterviewerDashboardLayout({ children }: Props) {
  const { userId } = await auth();

  if (!userId) {
    redirect("/interviewer/sign-in");
  }

  const user = await syncUser("INTERVIEWER", userId);

  if (!user || user.role !== "INTERVIEWER") {
    redirect("/not-authorized");
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="grid min-h-screen md:grid-cols-[240px_1fr]">
        <aside className="hidden border-r md:block">
          <InterviewerSidebar />
        </aside>

        <div className="flex min-h-screen flex-1 flex-col">
          <InterviewerTopbar />
          <div className="flex-1 overflow-y-auto">{children}</div>
        </div>
      </div>
    </div>
  );
}
