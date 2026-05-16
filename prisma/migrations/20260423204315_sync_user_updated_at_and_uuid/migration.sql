-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('Admin', 'Employee', 'Client');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "two_fa_pin" VARCHAR(10),
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_unique_number" VARCHAR(30) NOT NULL,
    "company_name" VARCHAR(200) NOT NULL,
    "contact_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "mobile" VARCHAR(25),
    "address" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_unique_number" VARCHAR(30) NOT NULL,
    "job_title" VARCHAR(120) NOT NULL,
    "national_insurance_number" VARCHAR(20) NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "wage_rate" DECIMAL(10,2) NOT NULL,
    "address" TEXT,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "idea_price" DECIMAL(12,2) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients_services" (
    "client_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "charged_price" DECIMAL(12,2) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,

    CONSTRAINT "clients_services_pkey" PRIMARY KEY ("client_id","service_id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shipment_type" VARCHAR(20) NOT NULL,
    "packaging_type" VARCHAR(20) NOT NULL,
    "courier_name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments_services_mapping" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,

    CONSTRAINT "shipments_services_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "category_name" VARCHAR(80) NOT NULL,
    "is_system_generated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "date" DATE NOT NULL,
    "receipt_image_url" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_attendance_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "login_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "logout_timestamp" TIMESTAMPTZ(6),
    "status" VARCHAR(20) NOT NULL,
    "date" DATE NOT NULL,

    CONSTRAINT "employee_attendance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_attendance_summary" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month_year" DATE NOT NULL,
    "total_days_present" INTEGER NOT NULL DEFAULT 0,
    "total_late_arrivals" INTEGER NOT NULL DEFAULT 0,
    "total_hours_worked" DECIMAL(8,2) NOT NULL DEFAULT 0,

    CONSTRAINT "monthly_attendance_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" UUID NOT NULL,
    "location_name" VARCHAR(150) NOT NULL,
    "location_class" VARCHAR(20) NOT NULL,
    "parent_location_id" UUID,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "sku_code" VARCHAR(80) NOT NULL,
    "barcode" VARCHAR(64),
    "product_name" VARCHAR(200) NOT NULL,
    "colour" VARCHAR(50),
    "size" VARCHAR(50),
    "weight" DECIMAL(10,3),
    "threshold_limit" INTEGER NOT NULL DEFAULT 0,
    "is_deactivated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "current_quantity" INTEGER NOT NULL DEFAULT 0,
    "arrived_today_quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_ledger" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "movement_type" VARCHAR(30) NOT NULL,
    "quantity_changed" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_loss_logs" (
    "id" UUID NOT NULL,
    "month_year" DATE NOT NULL,
    "total_earnings" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_expenses" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_profit" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "profit_loss_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_invoices" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "additional_charges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL,
    "pdf_link" TEXT,

    CONSTRAINT "monthly_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "base_salary" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fines" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rewards" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_pay" DECIMAL(14,2) NOT NULL,
    "month_year" DATE NOT NULL,

    CONSTRAINT "payroll_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "clients_user_id_key" ON "clients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_client_unique_number_key" ON "clients"("client_unique_number");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_unique_number_key" ON "employees"("employee_unique_number");

-- CreateIndex
CREATE UNIQUE INDEX "employees_national_insurance_number_key" ON "employees"("national_insurance_number");

-- CreateIndex
CREATE INDEX "idx_clients_services_service_id" ON "clients_services"("service_id");

-- CreateIndex
CREATE INDEX "idx_shipments_employee_created_at" ON "shipments"("employee_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_shipments_services_shipment_id" ON "shipments_services_mapping"("shipment_id");

-- CreateIndex
CREATE INDEX "idx_shipments_services_service_id" ON "shipments_services_mapping"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipments_services_pair" ON "shipments_services_mapping"("shipment_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_category_name_key" ON "expense_categories"("category_name");

-- CreateIndex
CREATE INDEX "idx_expenses_category_date" ON "expenses"("category_id", "date");

-- CreateIndex
CREATE INDEX "idx_expenses_date" ON "expenses"("date");

-- CreateIndex
CREATE INDEX "idx_attendance_user_date" ON "employee_attendance_logs"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_attendance_user_date" ON "employee_attendance_logs"("user_id", "date");

-- CreateIndex
CREATE INDEX "idx_monthly_attendance_user_month" ON "monthly_attendance_summary"("user_id", "month_year");

-- CreateIndex
CREATE UNIQUE INDEX "uq_monthly_attendance_user_month" ON "monthly_attendance_summary"("user_id", "month_year");

-- CreateIndex
CREATE INDEX "idx_warehouse_parent_location" ON "warehouse_locations"("parent_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_products_barcode_unique" ON "products"("barcode");

-- CreateIndex
CREATE INDEX "idx_products_client_id" ON "products"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_products_client_sku" ON "products"("client_id", "sku_code");

-- CreateIndex
CREATE INDEX "idx_stock_levels_product_id" ON "stock_levels"("product_id");

-- CreateIndex
CREATE INDEX "idx_stock_levels_location_id" ON "stock_levels"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stock_levels_product_location" ON "stock_levels"("product_id", "location_id");

-- CreateIndex
CREATE INDEX "idx_inventory_ledger_product_time" ON "inventory_ledger"("product_id", "timestamp");

-- CreateIndex
CREATE INDEX "idx_inventory_ledger_user_time" ON "inventory_ledger"("user_id", "timestamp");

-- CreateIndex
CREATE INDEX "idx_inventory_ledger_location_time" ON "inventory_ledger"("location_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "uq_profit_loss_month" ON "profit_loss_logs"("month_year");

-- CreateIndex
CREATE INDEX "idx_monthly_invoices_client_status" ON "monthly_invoices"("client_id", "status");

-- CreateIndex
CREATE INDEX "idx_payroll_records_month" ON "payroll_records"("month_year");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payroll_user_month" ON "payroll_records"("user_id", "month_year");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients_services" ADD CONSTRAINT "clients_services_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients_services" ADD CONSTRAINT "clients_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments_services_mapping" ADD CONSTRAINT "shipments_services_mapping_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments_services_mapping" ADD CONSTRAINT "shipments_services_mapping_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_attendance_logs" ADD CONSTRAINT "employee_attendance_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_attendance_summary" ADD CONSTRAINT "monthly_attendance_summary_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_parent_location_id_fkey" FOREIGN KEY ("parent_location_id") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger" ADD CONSTRAINT "inventory_ledger_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_invoices" ADD CONSTRAINT "monthly_invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
