import { UserButton } from "@clerk/nextjs";
import { Separator } from "@/components/ui/separator";

type Props = {
  children: React.ReactNode;
};

export default function CandidateDashboardLayout({ children }: Props) {
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div>
            <p className="text-sm font-medium">Candidate Dashboard</p>
          </div>
          <UserButton />
        </div>
        <Separator />
      </header>

      <div className="mx-auto w-full max-w-6xl px-2 py-4 md:px-4">{children}</div>
    </div>
  );
}
