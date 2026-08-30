#!/usr/bin/env node
'use strict';

/**
 * Gives an Employee profile to every user with role 'employee' that lacks one.
 *
 * Two routes created employees and only one of them created the profile.
 * POST /api/users/add made the login; the Employees page made both. Anyone
 * added through the Users page therefore had a login and no profile — and
 * because a Shipment references the profile rather than the user, they could
 * not be assigned any work. The create-shipment dialog builds its operator list
 * from profiles, found none, and refused to open with "Need registered clients
 * and employees" while the employees plainly existed.
 *
 * addNewUser creates the profile now, so this is a one-off for accounts made
 * before that. Safe to run more than once: it only touches users that have no
 * profile, and reports what it did rather than working silently.
 *
 *   npm run backfill:employees
 */

require('dotenv').config();

const { prisma } = require('../lib/prisma');
const employeeRepository = require('../repositories/employee.repository');

const run = async () => {
  const orphans = await prisma.user.findMany({
    where: { role: 'employee', employee: null },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: { email: 'asc' },
  });

  if (orphans.length === 0) {
    console.log('\n  backfill:employees — every employee already has a profile.\n');
    return 0;
  }

  console.log(
    `\n  backfill:employees — ${orphans.length} employee login(s) without a profile:\n`,
  );

  let created = 0;
  for (const user of orphans) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || '(unnamed)';
    try {
      // Through the repository, which supplies the employee number: the
      // schema's @default(dbgenerated()) is a fiction, the column has no
      // database default and is NOT NULL.
      await employeeRepository.createEmployee({ userId: user.id });
      created += 1;
      console.log(`    created  ${name} <${user.email}>`);
    } catch (err) {
      console.error(`    FAILED   ${name} <${user.email}>: ${err.message}`);
    }
  }

  console.log(
    `\n  ${created} of ${orphans.length} profile(s) created. ` +
      'Those accounts can now be assigned shipments.\n',
  );

  return orphans.length - created;
};

run()
  .then(async (failures) => {
    await prisma.$disconnect();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('\n  backfill:employees failed:', err.message, '\n');
    await prisma.$disconnect();
    process.exit(1);
  });
