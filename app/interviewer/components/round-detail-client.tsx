"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  addCandidates,
  addInvitee,
  removeCandidate,
  removeInvitee,
  scheduleRound,
  updateInvitePermission,
} from "@/app/interviewer/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type PermissionValue = "READ" | "MANAGE_INVITEES" | "MANAGE_CANDIDATES" | "FULL";
type InviteStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "REVOKED";
type RoundConductedBy = "AI" | "HUMAN";

type InviteeRow = {
  id: string;
  invitee: {
    id: string;
    name: string | null;
    email: string | null;
  };
  inviter: {
    id: string;
    name: string | null;
    email: string | null;
  };
  status: InviteStatus;
  permissions: PermissionValue[];
  createdAt: string;
};

type CandidateRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
};

type InterviewerSearchResult = {
  id: string;
  email: string | null;
  name: string | null;
  clerkUserId: string;
};

type ScheduleRow = {
  id: string;
  startAt: string;
  minutesPerCandidate: number;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
  breakStart: string | null;
  breakEnd: string | null;
  skipDates: string[];
};

type SlotRow = {
  id: string;
  candidateEmail: string;
  startAt: string;
  endAt: string;
  meetingToken: string | null;
  meetingStatus: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | null;
  completedAt: string | null;
  endedAt: string | null;
};

type RoundDetailClientProps = {
  roundId: string;
  roundConductedBy: RoundConductedBy;
  isClosed: boolean;
  schedulingLocked: boolean;
  schedule: ScheduleRow | null;
  slots: SlotRow[];
  invitees: InviteeRow[];
  candidates: CandidateRow[];
  canManageInvitees: boolean;
  canManageCandidates: boolean;
  canSchedule: boolean;
};

const permissionOptions: Array<{ value: PermissionValue; label: string }> = [
  { value: "READ", label: "Read only" },
  { value: "MANAGE_INVITEES", label: "Manage invitees" },
  { value: "MANAGE_CANDIDATES", label: "Manage candidates" },
  { value: "FULL", label: "Full access" },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function badgeVariantForStatus(status: InviteStatus) {
  if (status === "ACCEPTED") return "default";
  if (status === "PENDING") return "secondary";
  if (status === "DECLINED") return "outline";
  return "destructive";
}

export function RoundDetailClient({
  roundId,
  roundConductedBy,
  isClosed,
  schedulingLocked,
  schedule,
  slots,
  invitees,
  candidates,
  canManageInvitees,
  canManageCandidates,
  canSchedule,
}: RoundDetailClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InterviewerSearchResult[]>([]);
  const [newInvitePermission, setNewInvitePermission] = useState<PermissionValue>("READ");
  const [candidateInput, setCandidateInput] = useState("");
  const [permissionDrafts, setPermissionDrafts] = useState<Record<string, PermissionValue>>(() =>
    Object.fromEntries(
      invitees.map((invite) => [invite.id, (invite.permissions[0] ?? "READ") as PermissionValue]),
    ),
  );

  const [scheduleStartAt, setScheduleStartAt] = useState("");
  const [minutesPerCandidate, setMinutesPerCandidate] = useState("30");
  const [workingHoursStart, setWorkingHoursStart] = useState("09:00");
  const [workingHoursEnd, setWorkingHoursEnd] = useState("18:00");
  const [breakStart, setBreakStart] = useState("");
  const [breakEnd, setBreakEnd] = useState("");
  const [exceptionalDates, setExceptionalDates] = useState("");

  const activeInviteeIds = useMemo(
    () =>
      new Set(
        invitees
          .filter((invite) => invite.status !== "REVOKED")
          .map((invite) => invite.invitee.id),
      ),
    [invitees],
  );

  const inviteesReadOnly = isClosed || !canManageInvitees;
  const candidatesReadOnly = isClosed || schedulingLocked || !canManageCandidates;
  const scheduleReadOnly = isClosed || !canSchedule || Boolean(schedule);
  const slotLabel = roundConductedBy === "AI" ? "AI Interview Slot" : "Interview Time";

  useEffect(() => {
    if (inviteesReadOnly) {
      return;
    }

    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(
          `/interviewer/api/interviewers/search?q=${encodeURIComponent(trimmedQuery)}`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error("Unable to search interviewers");
        }

        const data = (await response.json()) as InterviewerSearchResult[];
        setSearchResults(data.filter((result) => !activeInviteeIds.has(result.id)));
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setSearchResults([]);
        }
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [searchQuery, inviteesReadOnly, activeInviteeIds]);

  function onAddInvitee(inviteeId: string) {
    startTransition(async () => {
      const result = await addInvitee({
        roundId,
        inviteeId,
        permission: newInvitePermission,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Invite sent");
      setSearchQuery("");
      setSearchResults([]);
      router.refresh();
    });
  }

  function onUpdateInvitePermission(inviteId: string) {
    const permission = permissionDrafts[inviteId] ?? "READ";

    startTransition(async () => {
      const result = await updateInvitePermission({
        roundId,
        inviteId,
        permission,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Permission updated");
      router.refresh();
    });
  }

  function onRevokeInvite(inviteId: string) {
    startTransition(async () => {
      const result = await removeInvitee({ roundId, inviteId });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Invite revoked");
      router.refresh();
    });
  }

  function onAddCandidates() {
    startTransition(async () => {
      const result = await addCandidates({
        roundId,
        candidateEmails: candidateInput,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Candidates added");
      setCandidateInput("");
      router.refresh();
    });
  }

  function onRemoveCandidate(candidateId: string) {
    startTransition(async () => {
      const result = await removeCandidate({ roundId, candidateId });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Candidate removed");
      router.refresh();
    });
  }

  function onScheduleRound() {
    startTransition(async () => {
      const result = await scheduleRound({
        roundId,
        startAt: scheduleStartAt,
        minutesPerCandidate: Number(minutesPerCandidate),
        workingHoursStart,
        workingHoursEnd,
        breakStart,
        breakEnd,
        exceptionalDates,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Schedule created");
      router.refresh();
    });
  }

  return (
    <Tabs defaultValue="invitees">
      <TabsList>
        <TabsTrigger value="invitees">Invitees</TabsTrigger>
        <TabsTrigger value="candidates">Candidates</TabsTrigger>
        <TabsTrigger value="schedule">Schedule</TabsTrigger>
      </TabsList>

      <TabsContent value="invitees" className="space-y-4">
        {isClosed && (
          <p className="text-sm text-muted-foreground">
            This round is closed. Invitee updates are disabled.
          </p>
        )}

        {!inviteesReadOnly && (
          <div className="rounded-md border p-4">
            <p className="mb-3 text-sm font-medium">Add interviewer guest</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[280px] flex-1 space-y-2">
                <Label htmlFor="round-invitee-search">Search by interviewer email</Label>
                <Input
                  id="round-invitee-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Type at least 2 characters"
                />
              </div>
              <div className="w-[220px] space-y-2">
                <Label>Permission</Label>
                <Select
                  value={newInvitePermission}
                  onValueChange={(value) => setNewInvitePermission(value as PermissionValue)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Permission" />
                  </SelectTrigger>
                  <SelectContent>
                    {permissionOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {searchResults.length > 0 && (
              <div className="mt-3 space-y-2 rounded-md border p-3">
                {searchResults.map((result) => (
                  <div
                    key={result.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{result.name ?? "Unnamed interviewer"}</p>
                      <p className="truncate text-xs text-muted-foreground">{result.email ?? "No email"}</p>
                    </div>
                    <Button
                      size="sm"
                      type="button"
                      disabled={pending}
                      onClick={() => onAddInvitee(result.id)}
                    >
                      Add
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invitee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Created</TableHead>
                {!inviteesReadOnly && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitees.length === 0 && (
                <TableRow>
                  <TableCell colSpan={inviteesReadOnly ? 5 : 6} className="text-muted-foreground">
                    No invitees yet.
                  </TableCell>
                </TableRow>
              )}

              {invitees.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{invite.invitee.name ?? "Unnamed interviewer"}</p>
                      <p className="text-xs text-muted-foreground">{invite.invitee.email ?? "No email"}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={badgeVariantForStatus(invite.status)}>{invite.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {invite.permissions.map((permission) => (
                        <Badge key={`${invite.id}-${permission}`} variant="outline">
                          {permission}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="text-sm">{invite.inviter.name ?? "Unknown"}</p>
                      <p className="text-xs text-muted-foreground">{invite.inviter.email ?? ""}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(invite.createdAt)}
                  </TableCell>

                  {!inviteesReadOnly && (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Select
                          value={permissionDrafts[invite.id] ?? "READ"}
                          onValueChange={(value) =>
                            setPermissionDrafts((current) => ({
                              ...current,
                              [invite.id]: value as PermissionValue,
                            }))
                          }
                        >
                          <SelectTrigger className="w-[170px]">
                            <SelectValue placeholder="Permission" />
                          </SelectTrigger>
                          <SelectContent>
                            {permissionOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => onUpdateInvitePermission(invite.id)}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={pending}
                          onClick={() => onRevokeInvite(invite.id)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <TabsContent value="candidates" className="space-y-4">
        {isClosed && (
          <p className="text-sm text-muted-foreground">
            This round is closed. Candidate updates are disabled.
          </p>
        )}

        {schedulingLocked && (
          <p className="text-sm text-muted-foreground">
            Candidate list is locked because scheduling is active.
          </p>
        )}

        {!candidatesReadOnly && (
          <div className="rounded-md border p-4">
            <Label htmlFor="round-candidates" className="mb-2 block">
              Add candidate emails (comma/newline separated)
            </Label>
            <p className="mb-2 text-xs text-muted-foreground">
              Invitations are sent only after schedule slots are generated.
            </p>
            <Textarea
              id="round-candidates"
              value={candidateInput}
              onChange={(event) => setCandidateInput(event.target.value)}
              placeholder={"candidate1@mail.com\ncandidate2@mail.com"}
            />
            <div className="mt-3 flex justify-end">
              <Button type="button" disabled={pending} onClick={onAddCandidates}>
                Add candidates
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Added</TableHead>
                {!candidatesReadOnly && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={candidatesReadOnly ? 3 : 4} className="text-muted-foreground">
                    No candidates added yet.
                  </TableCell>
                </TableRow>
              )}

              {candidates.map((candidate) => (
                <TableRow key={candidate.id}>
                  <TableCell className="font-medium">{candidate.email}</TableCell>
                  <TableCell>{candidate.name ?? "-"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(candidate.createdAt)}
                  </TableCell>

                  {!candidatesReadOnly && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => onRemoveCandidate(candidate.id)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabsContent>

      <TabsContent value="schedule" className="space-y-4">
        <div className="rounded-md border p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{roundConductedBy}</Badge>
            {isClosed && <Badge variant="secondary">Closed</Badge>}
            {schedulingLocked && <Badge>Candidate list locked</Badge>}
          </div>

          <p className="mb-3 text-sm text-muted-foreground">
            {roundConductedBy === "AI"
              ? "Scheduling defines each candidate's AI interview window."
              : "Scheduling defines each candidate's human interview time."}
          </p>

          {schedule && (
            <div className="space-y-2 text-sm">
              <p>
                <span className="font-medium">Start:</span> {formatDateTime(schedule.startAt)}
              </p>
              <p>
                <span className="font-medium">Minutes per candidate:</span>{" "}
                {schedule.minutesPerCandidate}
              </p>
              <p>
                <span className="font-medium">Working hours:</span>{" "}
                {schedule.workingHoursStart && schedule.workingHoursEnd
                  ? `${schedule.workingHoursStart} - ${schedule.workingHoursEnd}`
                  : "Not set"}
              </p>
              <p>
                <span className="font-medium">Break:</span>{" "}
                {schedule.breakStart && schedule.breakEnd
                  ? `${schedule.breakStart} - ${schedule.breakEnd}`
                  : "Not set"}
              </p>
              <p>
                <span className="font-medium">Exceptional days:</span>{" "}
                {schedule.skipDates.length > 0 ? schedule.skipDates.join(", ") : "None"}
              </p>
            </div>
          )}
        </div>

        {slots.length > 0 && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>{slotLabel} Start</TableHead>
                  <TableHead>{slotLabel} End</TableHead>
                  <TableHead>Meeting</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slots.map((slot) => (
                  <TableRow key={slot.id}>
                    <TableCell>{slot.candidateEmail}</TableCell>
                    <TableCell>{formatDateTime(slot.startAt)}</TableCell>
                    <TableCell>{formatDateTime(slot.endAt)}</TableCell>
                    <TableCell>
                      {slot.meetingToken ? (() => {
                        const isCompleted =
                          slot.meetingStatus === "COMPLETED" ||
                          Boolean(slot.completedAt || slot.endedAt);

                        if (isCompleted) {
                          return (
                            <Button size="sm" variant="secondary" disabled>
                              Completed
                            </Button>
                          );
                        }

                        return (
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/meet/${slot.meetingToken}`}>
                              {roundConductedBy === "AI" ? "Open AI Interview" : "Join"}
                            </Link>
                          </Button>
                        );
                      })() : (
                        <span className="text-xs text-muted-foreground">Not available</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!scheduleReadOnly && (
          <div className="rounded-md border p-4 space-y-3">
            <p className="text-sm font-medium">
              {roundConductedBy === "AI" ? "Create AI slot schedule" : "Create schedule"}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="schedule-start">Start date and time</Label>
                <Input
                  id="schedule-start"
                  type="datetime-local"
                  value={scheduleStartAt}
                  onChange={(event) => setScheduleStartAt(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schedule-duration">Minutes per candidate</Label>
                <Input
                  id="schedule-duration"
                  type="number"
                  min={5}
                  value={minutesPerCandidate}
                  onChange={(event) => setMinutesPerCandidate(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="working-start">Working hours start (optional)</Label>
                <Input
                  id="working-start"
                  type="time"
                  value={workingHoursStart}
                  onChange={(event) => setWorkingHoursStart(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="working-end">Working hours end (optional)</Label>
                <Input
                  id="working-end"
                  type="time"
                  value={workingHoursEnd}
                  onChange={(event) => setWorkingHoursEnd(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="break-start">Break start (optional)</Label>
                <Input
                  id="break-start"
                  type="time"
                  value={breakStart}
                  onChange={(event) => setBreakStart(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="break-end">Break end (optional)</Label>
                <Input
                  id="break-end"
                  type="time"
                  value={breakEnd}
                  onChange={(event) => setBreakEnd(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="exceptional-days">Exceptional days (YYYY-MM-DD, comma/newline)</Label>
              <Textarea
                id="exceptional-days"
                value={exceptionalDates}
                onChange={(event) => setExceptionalDates(event.target.value)}
                placeholder={"2026-03-10\n2026-03-14"}
              />
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={onScheduleRound} disabled={pending}>
                Generate schedule slots & send invitations
              </Button>
            </div>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
