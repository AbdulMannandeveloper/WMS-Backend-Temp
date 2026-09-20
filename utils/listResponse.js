'use strict';

/**
 * How a list endpoint answers when something goes wrong.
 *
 * Query parameters are the part of the API a person reaches by typing, so the
 * failure that matters is a malformed one. utils/queryFilters throws a
 * QueryParamError carrying `status: 400` for those; everything else is a fault
 * on our side and answers 500.
 *
 * The 500 branch deliberately does not return err.message. Prisma's errors name
 * the column, the model and sometimes the query — `Invalid prisma.user.findMany()
 * invocation`, P2023 quoting a uuid — which tells someone probing the shape of
 * the schema and tells the operator nothing they cannot get from the log.
 */
const listError = (res, err, context) => {
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error(`[${context}]`, err);
  return res.status(500).json({ error: 'Internal server error' });
};

module.exports = { listError };
