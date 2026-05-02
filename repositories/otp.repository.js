const { prisma } = require('../lib/prisma');

const prismaOtp = prisma.otpVerification;

const createOtp = async ({ userId, codeHash, expiresAt }) => {
  await prismaOtp.deleteMany({ where: { userId } });

  return prismaOtp.create({
    data: {
      userId,
      codeHash,
      expiresAt,
    },
  });
};

const getLatestOtpByUserId = async (userId) => {
  return prismaOtp.findFirst({
    where: { userId },
    orderBy: { id: 'desc' },
  });
};

const incrementAttemptsById = async (id) => {
  return prismaOtp.update({
    where: { id },
    data: {
      attempts: {
        increment: 1,
      },
    },
  });
};

const deleteOtpById = async (id) => {
  return prismaOtp.delete({
    where: { id },
  });
};

module.exports = {
  createOtp,
  getLatestOtpByUserId,
  incrementAttemptsById,
  deleteOtpById,
};
