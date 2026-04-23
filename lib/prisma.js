'use strict';

const { PrismaClient } = require('@prisma/client');

const globalForPrisma = global;

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

const connectDB = async () => {
  await prisma.$connect();
  const result = await prisma.$queryRaw`SELECT NOW() AS connected_at`;
  console.log(
    `[DB] Connected to PostgreSQL successfully via Prisma - server time: ${result[0].connected_at}`
  );
};

module.exports = {
  prisma,
  connectDB,
};