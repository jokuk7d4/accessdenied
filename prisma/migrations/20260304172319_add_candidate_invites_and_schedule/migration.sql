-- CreateEnum
CREATE TYPE "RoundConductedBy" AS ENUM ('AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "CandidateInviteStatus" AS ENUM ('SENT', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "InterviewRound" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "conductedBy" "RoundConductedBy" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "schedulingLocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CandidateInvite" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "candidateEmail" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "CandidateInviteStatus" NOT NULL DEFAULT 'SENT',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateRoundMembership" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateEmail" TEXT NOT NULL,
    "inviteId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateRoundMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundSchedule" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "minutesPerCandidate" INTEGER NOT NULL,
    "workingHoursStart" TEXT,
    "workingHoursEnd" TEXT,
    "breakStart" TEXT,
    "breakEnd" TEXT,
    "skipDates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundCandidateSlot" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "candidateEmail" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundCandidateSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CandidateInvite_token_key" ON "CandidateInvite"("token");

-- CreateIndex
CREATE INDEX "CandidateInvite_roundId_status_idx" ON "CandidateInvite"("roundId", "status");

-- CreateIndex
CREATE INDEX "CandidateInvite_candidateEmail_status_idx" ON "CandidateInvite"("candidateEmail", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateInvite_roundId_candidateEmail_key" ON "CandidateInvite"("roundId", "candidateEmail");

-- CreateIndex
CREATE INDEX "CandidateRoundMembership_userId_idx" ON "CandidateRoundMembership"("userId");

-- CreateIndex
CREATE INDEX "CandidateRoundMembership_roundId_idx" ON "CandidateRoundMembership"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateRoundMembership_roundId_userId_key" ON "CandidateRoundMembership"("roundId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateRoundMembership_roundId_candidateEmail_key" ON "CandidateRoundMembership"("roundId", "candidateEmail");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateRoundMembership_inviteId_key" ON "CandidateRoundMembership"("inviteId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundSchedule_roundId_key" ON "RoundSchedule"("roundId");

-- CreateIndex
CREATE INDEX "RoundCandidateSlot_roundId_startAt_idx" ON "RoundCandidateSlot"("roundId", "startAt");

-- CreateIndex
CREATE INDEX "RoundCandidateSlot_candidateEmail_idx" ON "RoundCandidateSlot"("candidateEmail");

-- CreateIndex
CREATE UNIQUE INDEX "RoundCandidateSlot_roundId_candidateEmail_key" ON "RoundCandidateSlot"("roundId", "candidateEmail");

-- CreateIndex
CREATE INDEX "InterviewRound_ownerId_deletedAt_idx" ON "InterviewRound"("ownerId", "deletedAt");

-- CreateIndex
CREATE INDEX "InterviewRound_closedAt_idx" ON "InterviewRound"("closedAt");

-- AddForeignKey
ALTER TABLE "CandidateInvite" ADD CONSTRAINT "CandidateInvite_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateInvite" ADD CONSTRAINT "CandidateInvite_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateRoundMembership" ADD CONSTRAINT "CandidateRoundMembership_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateRoundMembership" ADD CONSTRAINT "CandidateRoundMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateRoundMembership" ADD CONSTRAINT "CandidateRoundMembership_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "CandidateInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundSchedule" ADD CONSTRAINT "RoundSchedule_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundCandidateSlot" ADD CONSTRAINT "RoundCandidateSlot_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
