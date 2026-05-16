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

const getValidTokenByHashWithUser = async (tokenHash) => {
  return prismaInvitationToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          email: true,
          role: true,
          isActive: true,
        },
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
  getValidTokenByHashWithUser,
  markTokenUsed,
};
