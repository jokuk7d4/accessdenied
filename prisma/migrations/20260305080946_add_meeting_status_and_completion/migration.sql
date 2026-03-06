-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "MeetingRoom" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedByUserId" TEXT,
ADD COLUMN     "joinCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED';

-- CreateIndex
CREATE INDEX "MeetingRoom_status_idx" ON "MeetingRoom"("status");

-- CreateIndex
CREATE INDEX "MeetingRoom_completedAt_idx" ON "MeetingRoom"("completedAt");

-- AddForeignKey
ALTER TABLE "MeetingRoom" ADD CONSTRAINT "MeetingRoom_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
