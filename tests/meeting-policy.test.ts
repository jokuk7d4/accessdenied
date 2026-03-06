import { describe, expect, it } from "vitest";

import {
  canJoinMeeting,
  canMarkMeetingCompleted,
  hasMeetingWriteAccess,
  statusAfterJoin,
} from "../lib/meeting-policy";

describe("meeting join/completion policy", () => {
  it("candidate can join multiple times while meeting is not completed", () => {
    const firstJoinStatus = statusAfterJoin("SCHEDULED");
    const secondJoinStatus = statusAfterJoin(firstJoinStatus);

    expect(firstJoinStatus).toBe("IN_PROGRESS");
    expect(secondJoinStatus).toBe("IN_PROGRESS");
    expect(canJoinMeeting(firstJoinStatus)).toBe(true);
    expect(canJoinMeeting(secondJoinStatus)).toBe(true);
  });

  it("candidate cannot mark completed", () => {
    expect(
      canMarkMeetingCompleted({
        participantKind: "CANDIDATE",
      }),
    ).toBe(false);
  });

  it("interviewer with write can mark completed", () => {
    expect(
      canMarkMeetingCompleted({
        participantKind: "INTERVIEWER",
      }),
    ).toBe(true);
  });

  it("guest interviewer with write permission can mark completed", () => {
    expect(
      canMarkMeetingCompleted({
        participantKind: "GUEST_INTERVIEWER",
        invitePermissions: ["MANAGE_CANDIDATES"],
      }),
    ).toBe(true);
  });

  it("guest interviewer without write permission cannot mark completed", () => {
    expect(
      canMarkMeetingCompleted({
        participantKind: "GUEST_INTERVIEWER",
        invitePermissions: ["READ"],
      }),
    ).toBe(false);
  });

  it("after completion, join is blocked", () => {
    expect(canJoinMeeting("COMPLETED")).toBe(false);
  });

  it("joining never transitions status to COMPLETED", () => {
    expect(statusAfterJoin("SCHEDULED")).not.toBe("COMPLETED");
    expect(statusAfterJoin("IN_PROGRESS")).not.toBe("COMPLETED");
  });

  it("owner always has write access", () => {
    expect(
      hasMeetingWriteAccess({
        participantKind: "OWNER",
      }),
    ).toBe(true);
  });
});
