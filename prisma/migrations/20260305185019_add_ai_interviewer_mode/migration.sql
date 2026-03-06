-- CreateEnum
CREATE TYPE "AiInterviewSessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AiInterviewTranscriptSpeaker" AS ENUM ('AI', 'CANDIDATE');

-- CreateEnum
CREATE TYPE "ProctoringViolationType" AS ENUM ('LOOK_LEFT', 'LOOK_RIGHT', 'LOOK_DOWN', 'MULTIPLE_WARNINGS');

-- CreateTable
CREATE TABLE "AiInterviewSession" (
    "id" TEXT NOT NULL,
    "meetingRoomId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "status" "AiInterviewSessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "questionPlan" JSONB,
    "aiScore" INTEGER,
    "finalScore" INTEGER,
    "summary" TEXT,
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weaknesses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "malpracticePenalty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiInterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInterviewTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "speaker" "AiInterviewTranscriptSpeaker" NOT NULL,
    "text" TEXT NOT NULL,
    "questionIdx" INTEGER,
    "isFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInterviewTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProctoringEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" "ProctoringViolationType" NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiProctoringEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiInterviewSession_meetingRoomId_key" ON "AiInterviewSession"("meetingRoomId");

-- CreateIndex
CREATE INDEX "AiInterviewSession_roundId_candidateUserId_idx" ON "AiInterviewSession"("roundId", "candidateUserId");

-- CreateIndex
CREATE INDEX "AiInterviewSession_status_createdAt_idx" ON "AiInterviewSession"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiInterviewTurn_sessionId_createdAt_idx" ON "AiInterviewTurn"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AiProctoringEvent_sessionId_occurredAt_idx" ON "AiProctoringEvent"("sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "AiProctoringEvent_type_occurredAt_idx" ON "AiProctoringEvent"("type", "occurredAt");

-- AddForeignKey
ALTER TABLE "AiInterviewSession" ADD CONSTRAINT "AiInterviewSession_meetingRoomId_fkey" FOREIGN KEY ("meetingRoomId") REFERENCES "MeetingRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInterviewSession" ADD CONSTRAINT "AiInterviewSession_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInterviewSession" ADD CONSTRAINT "AiInterviewSession_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInterviewTurn" ADD CONSTRAINT "AiInterviewTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiInterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProctoringEvent" ADD CONSTRAINT "AiProctoringEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiInterviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
