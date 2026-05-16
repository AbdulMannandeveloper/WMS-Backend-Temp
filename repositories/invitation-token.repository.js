const { prisma } = require('../lib/prisma');

const prismaInvitationToken = prisma.invitationToken;

const createInvitationToken = async ({ userId, tokenHash, expiresAt }) => {
  return prismaInvitationToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });
};

const invalidateUnusedUserTokens = async (userId) => {
  return prismaInvitationToken.updateMany({
    where: {
      userId,
      usedAt: null,
    },
    data: {
      usedAt: new Date(),
    },
  });
};

const getValidTokenByHash = async (tokenHash) => {
  return prismaInvitationToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
  });
};

const markTokenUsed = async (id) => {
  return prismaInvitationToken.update({
    where: { id },
    data: {
      usedAt: new Date(),
    },
  });
};

module.exports = {
  createInvitationToken,
  invalidateUnusedUserTokens,
  getValidTokenByHash,
  markTokenUsed,
};
