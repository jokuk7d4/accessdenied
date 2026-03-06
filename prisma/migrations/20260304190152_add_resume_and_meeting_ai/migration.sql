-- CreateEnum
CREATE TYPE "MeetingTranscriptSpeaker" AS ENUM ('CANDIDATE', 'INTERVIEWER');

-- CreateEnum
CREATE TYPE "MeetingAiSuggestionKind" AS ENUM ('SUMMARY', 'FOLLOW_UP', 'EVAL', 'QUESTION');

-- CreateEnum
CREATE TYPE "MeetingAiSuggestionSeverity" AS ENUM ('GOOD', 'WARN', 'BAD', 'NEUTRAL', 'QUESTION');

-- CreateTable
CREATE TABLE "ParsedResume" (
    "id" TEXT NOT NULL,
    "candidateUserId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParsedResume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingAiSession" (
    "id" TEXT NOT NULL,
    "meetingRoomId" TEXT NOT NULL,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "provider" TEXT NOT NULL,
    "summary" JSONB,
    "questionBank" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "MeetingAiSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingTranscriptTurn" (
    "id" TEXT NOT NULL,
    "meetingAiSessionId" TEXT NOT NULL,
    "speaker" "MeetingTranscriptSpeaker" NOT NULL,
    "speakerUserId" TEXT,
    "text" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingTranscriptTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingAiSuggestion" (
    "id" TEXT NOT NULL,
    "meetingAiSessionId" TEXT NOT NULL,
    "kind" "MeetingAiSuggestionKind" NOT NULL,
    "severity" "MeetingAiSuggestionSeverity" NOT NULL DEFAULT 'NEUTRAL',
    "text" TEXT NOT NULL,
    "relatedToTurnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingAiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParsedResume_candidateUserId_idx" ON "ParsedResume"("candidateUserId");

-- CreateIndex
CREATE INDEX "ParsedResume_roundId_idx" ON "ParsedResume"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "ParsedResume_candidateUserId_roundId_key" ON "ParsedResume"("candidateUserId", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingAiSession_meetingRoomId_key" ON "MeetingAiSession"("meetingRoomId");

-- CreateIndex
CREATE INDEX "MeetingAiSession_aiEnabled_idx" ON "MeetingAiSession"("aiEnabled");

-- CreateIndex
CREATE INDEX "MeetingTranscriptTurn_meetingAiSessionId_timestamp_idx" ON "MeetingTranscriptTurn"("meetingAiSessionId", "timestamp");

-- CreateIndex
CREATE INDEX "MeetingTranscriptTurn_speakerUserId_timestamp_idx" ON "MeetingTranscriptTurn"("speakerUserId", "timestamp");

-- CreateIndex
CREATE INDEX "MeetingAiSuggestion_meetingAiSessionId_createdAt_idx" ON "MeetingAiSuggestion"("meetingAiSessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ParsedResume" ADD CONSTRAINT "ParsedResume_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParsedResume" ADD CONSTRAINT "ParsedResume_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAiSession" ADD CONSTRAINT "MeetingAiSession_meetingRoomId_fkey" FOREIGN KEY ("meetingRoomId") REFERENCES "MeetingRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptTurn" ADD CONSTRAINT "MeetingTranscriptTurn_meetingAiSessionId_fkey" FOREIGN KEY ("meetingAiSessionId") REFERENCES "MeetingAiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingTranscriptTurn" ADD CONSTRAINT "MeetingTranscriptTurn_speakerUserId_fkey" FOREIGN KEY ("speakerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAiSuggestion" ADD CONSTRAINT "MeetingAiSuggestion_meetingAiSessionId_fkey" FOREIGN KEY ("meetingAiSessionId") REFERENCES "MeetingAiSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
