import { createHash, randomBytes } from "crypto";

export function generateMeetingToken() {
  return randomBytes(32).toString("hex");
}

export function hashMeetingToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
