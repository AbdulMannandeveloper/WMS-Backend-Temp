/**
 * Returns a new object containing only the allowed keys that are actually
 * present in the source object. Used to prevent mass-assignment: callers
 * pass an explicit allowlist so client-supplied fields such as role,
 * isActive, passwordHash, or foreign ids cannot be smuggled into writes.
 */
const pick = (source, allowedFields) => {
  const result = {};
  if (!source || typeof source !== 'object') {
    return result;
  }
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
};

/**
 * Guards dynamic Prisma "where: { [field]: value }" lookups where `field` comes
 * from a request parameter. Throws if the field is not explicitly allowed,
 * preventing attackers from probing arbitrary columns/relations.
 */
const assertAllowedField = (field, allowedFields) => {
  if (!allowedFields.includes(field)) {
    throw new Error('Invalid query field.');
  }
  return field;
};

module.exports = { pick, assertAllowedField };
