-- CreateEnum
CREATE TYPE "MeetingParticipantRole" AS ENUM ('CANDIDATE', 'INTERVIEWER');

-- CreateTable
CREATE TABLE "MeetingRoom" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "meetingToken" TEXT NOT NULL,
    "meetingTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,

    CONSTRAINT "MeetingRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingParticipant" (
    "id" TEXT NOT NULL,
    "meetingRoomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MeetingParticipantRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "MeetingParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingChatMessage" (
    "id" TEXT NOT NULL,
    "meetingRoomId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRoom_slotId_key" ON "MeetingRoom"("slotId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRoom_meetingToken_key" ON "MeetingRoom"("meetingToken");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRoom_meetingTokenHash_key" ON "MeetingRoom"("meetingTokenHash");

-- CreateIndex
CREATE INDEX "MeetingRoom_roundId_idx" ON "MeetingRoom"("roundId");

-- CreateIndex
CREATE INDEX "MeetingRoom_endedAt_idx" ON "MeetingRoom"("endedAt");

-- CreateIndex
CREATE INDEX "MeetingParticipant_meetingRoomId_leftAt_idx" ON "MeetingParticipant"("meetingRoomId", "leftAt");

-- CreateIndex
CREATE INDEX "MeetingParticipant_userId_joinedAt_idx" ON "MeetingParticipant"("userId", "joinedAt");

-- CreateIndex
CREATE INDEX "MeetingChatMessage_meetingRoomId_createdAt_idx" ON "MeetingChatMessage"("meetingRoomId", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingChatMessage_senderUserId_createdAt_idx" ON "MeetingChatMessage"("senderUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "MeetingRoom" ADD CONSTRAINT "MeetingRoom_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRoom" ADD CONSTRAINT "MeetingRoom_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "RoundCandidateSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingRoom" ADD CONSTRAINT "MeetingRoom_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_meetingRoomId_fkey" FOREIGN KEY ("meetingRoomId") REFERENCES "MeetingRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingParticipant" ADD CONSTRAINT "MeetingParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingChatMessage" ADD CONSTRAINT "MeetingChatMessage_meetingRoomId_fkey" FOREIGN KEY ("meetingRoomId") REFERENCES "MeetingRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingChatMessage" ADD CONSTRAINT "MeetingChatMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
