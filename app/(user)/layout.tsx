import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { syncUser } from "@/lib/syncUser";

type Props = {
  children: React.ReactNode;
};

export default async function UserLayout({ children }: Props) {
  const pathname = (await headers()).get("x-pathname") ?? "";
  const isUserAuthPage = pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");

  if (isUserAuthPage) {
    return <>{children}</>;
  }

  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  const user = await syncUser("CANDIDATE", userId);

  if (!user || user.role !== "CANDIDATE") {
    redirect("/not-authorized");
  }

  return <>{children}</>;
}
