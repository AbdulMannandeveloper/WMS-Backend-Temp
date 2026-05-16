const crypto = require("crypto");
const bcrypt = require("bcrypt");

const otpRepository = require("../repositories/otp.repository");
const userRepository = require("../repositories/user.repository");
const invitationTokenRepository = require("../repositories/invitation-token.repository");
const { sendMail } = require("../utils/mailer");
const {
  otpEmailTemplate,
  inviteEmailTemplate,
} = require("../utils/emailTemplates");

const SALT_ROUNDS = 10;
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const INVITE_EXPIRY_HOURS = Number(process.env.INVITE_EXPIRY_HOURS || 24);
const APP_BASE_URL = process.env.APP_BASE_URL || "https://myapp.com";

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const generateOtpCode = () => crypto.randomInt(100000, 1000000).toString();

const createOtpAndSendEmail = async (userId, email) => {
  const otp = generateOtpCode();
  const codeHash = hashValue(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  const otpRecord = await otpRepository.createOtp({
    userId,
    codeHash,
    expiresAt,
  });

  const emailContent = otpEmailTemplate({
    otp,
    expiresMinutes: OTP_EXPIRY_MINUTES,
  });

  const sent = await sendMail({
    to: email,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
  });

  if (!sent) {
    await otpRepository.deleteOtpById(otpRecord.id).catch(() => null);
    throw new Error("OTP email could not be sent.");
  }
};

const authenticateUser = async (identifier, password) => {
  let user = await userRepository.getUserByField("email", identifier);
  if (!user) {
    user = await userRepository.getUserByField("username", identifier);
  }

  if (!user) {
    throw new Error("User not found");
  }

  if (!user.isActive) {
    throw new Error(
      "The account is not active. Please complete verification first.",
    );
  }

  if (!user.passwordHash) {
    throw new Error(
      "Password is not set for this account. Please complete account setup.",
    );
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new Error("Invalid password");
  }

  await createOtpAndSendEmail(user.id, user.email);

  return user.id;
};

const requestAdminSignupOtp = async (payload) => {
  const { firstName, lastName, username, email, password } = payload;

  if (!firstName || !lastName || !email || !password) {
    throw new Error("First name, last name, email, and password are required.");
  }

  if (!/\S+@\S+\.\S+/.test(email)) {
    throw new Error("Invalid email format");
  }

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters long");
  }

  // Strict rule: only one admin signup path
  const users = await userRepository.getAllUsers();
  const adminExists = users.some((u) => u.role === "admin");
  if (adminExists) {
    throw new Error("Admin already exists.");
  }

  // Prevent collisions with existing accounts
  const existingByEmail = await userRepository.getUserByField("email", email);
  if (existingByEmail) {
    throw new Error("A user with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await userRepository.createUser({
    firstName,
    lastName,
    username,
    email,
    passwordHash,
    role: "admin",
    isActive: false,
  });

  try {
    await createOtpAndSendEmail(user.id, email);
  } catch (error) {
    await userRepository.deleteUser(user.id).catch(() => null);
    throw new Error(`Failed to send OTP email. ${error.message}`);
  }

  return { userId: user.id, email: user.email };
};

const verifyAdminSignupOtp = async ({ email, otp }) => {
  if (!email || !otp) {
    throw new Error("Email and OTP are required.");
  }

  const user = await userRepository.getUserByField("email", email);
  if (!user) {
    throw new Error("User not found");
  }

  const record = await otpRepository.getLatestOtpByUserId(user.id);
  if (!record) {
    throw new Error("OTP not found. Please request a new OTP.");
  }

  if (record.expiresAt < new Date()) {
    await otpRepository.deleteOtpById(record.id);
    throw new Error("OTP has expired. Please request a new one.");
  }

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await otpRepository.deleteOtpById(record.id);
    throw new Error("Too many failed attempts. OTP has been invalidated.");
  }

  const candidateHash = hashValue(otp);
  if (candidateHash !== record.codeHash) {
    await otpRepository.incrementAttemptsById(record.id);
    throw new Error("Invalid OTP.");
  }

  await otpRepository.deleteOtpById(record.id);
  await userRepository.updateUser(user.id, { isActive: true });

  return { verified: true, userId: user.id };
};



const verifyOTP = async (userId, otp) => {
  const user = await userRepository.getUserByField("id", userId);
  if (!user) {
    throw new Error("User not found");
  }

  return verifyAdminSignupOtp({ email: user.email, otp });
};



const inviteUserByAdmin = async ({
  adminId,
  username,
  email,
  firstName,
  lastName,
  role,
}) => {
  if (!adminId || !email || !firstName || !lastName || !role) {
    throw new Error(
      "adminId, firstName, lastName, role, and email are required.",
    );
  }

  if (!["employee", "client"].includes(role)) {
    throw new Error(
      "Role must be either employee or client for invited users.",
    );
  }

  const adminUser = await userRepository.getUserByField("id", adminId);
  if (!adminUser || adminUser.role !== "admin" || !adminUser.isActive) {
    throw new Error("Only an active admin can invite users.");
  }

  let targetUser = await userRepository.getUserByField("email", email);
  if (!targetUser) {
    targetUser = await userRepository.createUser({
      username,
      firstName,
      lastName,
      email,
      role,
      isActive: false,
      passwordHash: null,
    });
  } else {
    targetUser = await userRepository.updateUser(targetUser.id, {
      username,
      firstName,
      lastName,
      role,
      isActive: false,
      passwordHash: null,
    });
  }

  await invitationTokenRepository.invalidateUnusedUserTokens(targetUser.id);

  const plainToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashValue(plainToken);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await invitationTokenRepository.createInvitationToken({
    userId: targetUser.id,
    tokenHash,
    expiresAt,
  });

  const setupUrl = `${APP_BASE_URL}/setup-password?token=${plainToken}`;
  const emailContent = inviteEmailTemplate({
    setupUrl,
    expiresHours: INVITE_EXPIRY_HOURS,
  });

  const sent = await sendMail({
    to: targetUser.email,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
  });

  if (!sent) {
    throw new Error("Invitation email could not be sent.");
  }

  return { invited: true, userId: targetUser.id, email: targetUser.email };
};



const setupPasswordWithToken = async ({ token, password }) => {
  if (!token || !password) {
    throw new Error("Token and password are required.");
  }

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters long.");
  }

  const tokenHash = hashValue(token);
  const tokenRecord =
    await invitationTokenRepository.getValidTokenByHash(tokenHash);

  if (!tokenRecord) {
    throw new Error("Invalid or expired invitation token.");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await userRepository.updateUser(tokenRecord.userId, {
    passwordHash,
    isActive: true,
  });

  await invitationTokenRepository.markTokenUsed(tokenRecord.id);

  return { completed: true, userId: tokenRecord.userId };
};

module.exports = {
  authenticateUser,
  verifyOTP,
  requestAdminSignupOtp,
  verifyAdminSignupOtp,
  inviteUserByAdmin,
  setupPasswordWithToken,
};
