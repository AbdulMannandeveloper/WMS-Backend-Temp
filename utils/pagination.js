'use strict';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parse page/limit/offset from Express query params.
 * Returns Prisma-friendly { skip, take, page, limit }.
 */
const parsePagination = (query = {}) => {
  let page = Number.parseInt(query.page, 10);
  let limit = Number.parseInt(query.limit, 10);

  if (!Number.isFinite(page) || page < 1) page = DEFAULT_PAGE;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  return {
    page,
    limit,
    take: limit,
    skip: (page - 1) * limit,
  };
};

/**
 * Build a standard paginated response envelope.
 */
const paginatedResponse = (items, total, { page, limit }) => ({
  data: items,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: page * limit < total,
  },
});

module.exports = {
  parsePagination,
  paginatedResponse,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
