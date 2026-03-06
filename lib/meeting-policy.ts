export type MeetingStatus = "SCHEDULED" | "IN_PROGRESS" | "COMPLETED";
export type MeetingParticipantKind =
  | "OWNER"
  | "INTERVIEWER"
  | "GUEST_INTERVIEWER"
  | "CANDIDATE";

type WriteAccessInput = {
  participantKind: MeetingParticipantKind;
  invitePermissions?: Array<"READ" | "MANAGE_INVITEES" | "MANAGE_CANDIDATES" | "FULL">;
};

function hasPermissionWrite(
  permissions: WriteAccessInput["invitePermissions"],
) {
  if (!permissions || permissions.length === 0) {
    return false;
  }

  return permissions.some((permission) => permission !== "READ");
}

export function hasMeetingWriteAccess(input: WriteAccessInput) {
  if (input.participantKind === "OWNER" || input.participantKind === "INTERVIEWER") {
    return true;
  }

  if (input.participantKind === "GUEST_INTERVIEWER") {
    return hasPermissionWrite(input.invitePermissions);
  }

  return false;
}

export function canMarkMeetingCompleted(input: WriteAccessInput) {
  if (input.participantKind === "CANDIDATE") {
    return false;
  }

  return hasMeetingWriteAccess(input);
}

export function canJoinMeeting(status: MeetingStatus) {
  return status !== "COMPLETED";
}

export function statusAfterJoin(status: MeetingStatus): MeetingStatus {
  if (status === "COMPLETED") {
    return "COMPLETED";
  }

  if (status === "SCHEDULED") {
    return "IN_PROGRESS";
  }

  return "IN_PROGRESS";
}
