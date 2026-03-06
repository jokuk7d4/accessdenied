"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { createRound } from "@/app/interviewer/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type PermissionValue = "READ" | "MANAGE_INVITEES" | "MANAGE_CANDIDATES" | "FULL";
type ConductedByValue = "AI" | "HUMAN";

type InterviewerSearchResult = {
  id: string;
  email: string | null;
  name: string | null;
  clerkUserId: string;
};

type SelectedInvitee = InterviewerSearchResult & {
  permission: PermissionValue;
};

const permissionOptions: Array<{ value: PermissionValue; label: string }> = [
  { value: "READ", label: "Read only" },
  { value: "MANAGE_INVITEES", label: "Manage invitees" },
  { value: "MANAGE_CANDIDATES", label: "Manage candidates" },
  { value: "FULL", label: "Full access" },
];

export function CreateRoundDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [conductedBy, setConductedBy] = useState<ConductedByValue>("HUMAN");
  const [candidateEmails, setCandidateEmails] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InterviewerSearchResult[]>([]);
  const [selectedInvitees, setSelectedInvitees] = useState<SelectedInvitee[]>([]);

  const selectedInviteeIds = useMemo(
    () => new Set(selectedInvitees.map((invitee) => invitee.id)),
    [selectedInvitees],
  );

  useEffect(() => {
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
        setSearchResults(data.filter((item) => !selectedInviteeIds.has(item.id)));
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
  }, [searchQuery, selectedInviteeIds]);

  function resetState() {
    setTitle("");
    setDescription("");
    setConductedBy("HUMAN");
    setCandidateEmails("");
    setSearchQuery("");
    setSearchResults([]);
    setSelectedInvitees([]);
  }

  function addInvitee(result: InterviewerSearchResult) {
    setSelectedInvitees((current) => [
      ...current,
      {
        ...result,
        permission: "READ",
      },
    ]);
    setSearchQuery("");
    setSearchResults([]);
  }

  function updateInviteePermission(inviteeId: string, permission: PermissionValue) {
    setSelectedInvitees((current) =>
      current.map((invitee) =>
        invitee.id === inviteeId
          ? {
              ...invitee,
              permission,
            }
          : invitee,
      ),
    );
  }

  function removeInvitee(inviteeId: string) {
    setSelectedInvitees((current) => current.filter((invitee) => invitee.id !== inviteeId));
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await createRound({
        title,
        description,
        conductedBy,
        candidateEmails,
        invitees: selectedInvitees.map((invitee) => ({
          inviteeId: invitee.id,
          permission: invitee.permission,
        })),
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(result.message ?? "Round created");
      setOpen(false);
      resetState();
      const roundId = result.data?.roundId;

      if (roundId) {
        router.push(`/interviewer/rounds/${roundId}`);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          resetState();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>Create Round</Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Interview Round</DialogTitle>
          <DialogDescription>
            Add round details, candidate emails, and optional interviewer guests.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="round-title">Title</Label>
            <Input
              id="round-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Frontend Interview Round"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="round-description">Description (optional)</Label>
            <Textarea
              id="round-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add context or notes for this round"
            />
          </div>

          <div className="space-y-2">
            <Label>Conducted by</Label>
            <Select
              value={conductedBy}
              onValueChange={(value) => setConductedBy(value as ConductedByValue)}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Select mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HUMAN">HUMAN</SelectItem>
                <SelectItem value="AI">AI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="candidate-emails">
              Candidate emails (optional, comma or newline separated)
            </Label>
            <Textarea
              id="candidate-emails"
              value={candidateEmails}
              onChange={(event) => setCandidateEmails(event.target.value)}
              placeholder={"candidate1@mail.com\ncandidate2@mail.com"}
            />
          </div>

          <Separator />

          <div className="space-y-3">
            <Label htmlFor="invitee-search">Invite Interviewer Guests (optional)</Label>
            <Input
              id="invitee-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search interviewer by email"
            />

            {searchResults.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                {searchResults.map((result) => (
                  <div
                    key={result.id}
                    className="flex items-center justify-between gap-3 rounded-md border p-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{result.name ?? "Unnamed interviewer"}</p>
                      <p className="truncate text-xs text-muted-foreground">{result.email ?? "No email"}</p>
                    </div>
                    <Button type="button" size="sm" onClick={() => addInvitee(result)}>
                      Add
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {selectedInvitees.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                {selectedInvitees.map((invitee) => (
                  <div
                    key={invitee.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{invitee.name ?? "Unnamed interviewer"}</p>
                      <p className="truncate text-xs text-muted-foreground">{invitee.email ?? "No email"}</p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Select
                        value={invitee.permission}
                        onValueChange={(value) =>
                          updateInviteePermission(invitee.id, value as PermissionValue)
                        }
                      >
                        <SelectTrigger className="w-[180px]">
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
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => removeInvitee(invitee.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {selectedInvitees.length === 0 && (
              <Badge variant="outline">No interviewer guests selected</Badge>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetState();
              }}
            >
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={handleSubmit}>
              {pending ? "Creating..." : "Create round"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
