/*
  Warnings:

  - The primary key for the `clients_services` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[client_id,service_id]` on the table `clients_services` will be added. If there are existing duplicate values, this will fail.
  - The required column `id` was added to the `clients_services` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "clients_services" DROP CONSTRAINT "clients_services_pkey",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "clients_services_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "employees" ALTER COLUMN "job_title" DROP NOT NULL,
ALTER COLUMN "national_insurance_number" DROP NOT NULL,
ALTER COLUMN "date_of_birth" DROP NOT NULL,
ALTER COLUMN "wage_rate" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "uq_clients_services_pair" ON "clients_services"("client_id", "service_id");
