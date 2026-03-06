-- CreateEnum
CREATE TYPE "RoundInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RoundPermission" AS ENUM ('READ', 'MANAGE_INVITEES', 'MANAGE_CANDIDATES', 'FULL');

-- CreateTable
CREATE TABLE "InterviewRound" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundInterviewerInvite" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "status" "RoundInviteStatus" NOT NULL DEFAULT 'PENDING',
    "permissions" "RoundPermission"[] DEFAULT ARRAY['READ']::"RoundPermission"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundInterviewerInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundCandidate" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterviewRound_ownerId_idx" ON "InterviewRound"("ownerId");

-- CreateIndex
CREATE INDEX "RoundInterviewerInvite_inviteeId_status_idx" ON "RoundInterviewerInvite"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "RoundInterviewerInvite_roundId_idx" ON "RoundInterviewerInvite"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundInterviewerInvite_roundId_inviteeId_key" ON "RoundInterviewerInvite"("roundId", "inviteeId");

-- CreateIndex
CREATE INDEX "RoundCandidate_roundId_idx" ON "RoundCandidate"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "RoundCandidate_roundId_email_key" ON "RoundCandidate"("roundId", "email");

-- AddForeignKey
ALTER TABLE "InterviewRound" ADD CONSTRAINT "InterviewRound_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundInterviewerInvite" ADD CONSTRAINT "RoundInterviewerInvite_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundInterviewerInvite" ADD CONSTRAINT "RoundInterviewerInvite_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundInterviewerInvite" ADD CONSTRAINT "RoundInterviewerInvite_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundCandidate" ADD CONSTRAINT "RoundCandidate_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
