console.log("SCRIPT STARTING");
require('dotenv').config();
console.log("DB URL loaded:", process.env.DATABASE_URL ? "YES" : "NO");

const { prisma } = require('../lib/prisma');

async function run() {
  console.log("RUNNING USER QUERY...");
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        firstName: true,
        lastName: true
      }
    });
    console.log("QUERY COMPLETED, USERS FOUND:", users.length);
    console.log(JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("DB QUERY ERROR:", err);
  } finally {
    console.log("DISCONNECTING PRISMA...");
    await prisma.$disconnect();
    console.log("DISCONNECTED.");
  }
}

run();
