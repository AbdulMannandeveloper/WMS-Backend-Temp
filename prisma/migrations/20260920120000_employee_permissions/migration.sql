-- What an employee may do, as `module:action` strings.
--
-- On users rather than employees, and a column rather than a table, because
-- middlewares/authorize.js already loads this whole row on every request and
-- caches it in utils/authUserCache.js. Twelve short strings ride along on that
-- read for free; a relation would need an include on a repository several other
-- callers share, and a change to what the cache stores.
--
-- Default empty, deliberately. Nobody holds anything until an admin grants it,
-- which means every employee is refused on the governed routes from the moment
-- this lands — the admin screen ships in the same release for exactly that
-- reason. Admins are never governed by this column and clients are narrowed by
-- utils/clientScope.js instead, so both are unaffected.
--
-- No index: this is only ever read for the one authenticated user, by primary
-- key, and never searched.
ALTER TABLE "users"
  ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
