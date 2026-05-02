/*
  Warnings:

  - You are about to drop the column `created_at` on the `invitation_tokens` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "invitation_tokens" DROP COLUMN "created_at";
