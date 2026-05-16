/*
  Warnings:

  - You are about to drop the column `date` on the `holidays` table. All the data in the column will be lost.
  - Added the required column `endDate` to the `holidays` table without a default value. This is not possible if the table is not empty.
  - Added the required column `startDate` to the `holidays` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "holidays_date_key";

-- AlterTable
ALTER TABLE "holidays" DROP COLUMN "date",
ADD COLUMN     "endDate" DATE NOT NULL,
ADD COLUMN     "startDate" DATE NOT NULL;
