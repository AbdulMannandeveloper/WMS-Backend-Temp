// Must come first — PrismaClient reads DATABASE_URL when it is constructed.
import './load-env.js';

import { beforeEach, afterAll } from 'vitest';

import authCache from '../utils/authUserCache.js';
import { truncateAll, prisma } from './helpers/db.js';

const { clearAuthUserCache } = authCache;

beforeEach(async () => {
  await truncateAll();

  // middlewares/authorize.js caches users in an in-process Map for 45s. Without
  // this, a user truncated away above would still authenticate on the next test.
  await clearAuthUserCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});
