const crypto = require("crypto");
const bcrypt = require("bcrypt");

const otpRepository = require("../repositories/otp.repository");
const userRepository = require("../repositories/user.repository");
const invitationTokenRepository = require("../repositories/invitation-token.repository");
const attendanceLogLogic = require("./attendance_log.logic");
const { sendMail } = require("../utils/mailer");
const {
  otpEmailTemplate,
  inviteEmailTemplate,
  resetPasswordEmailTemplate,
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
  const { firstName, lastName, username, email } = payload;

  // US-001 & US-002: Ensure only the first user can register as admin
  const existingUsers = await userRepository.getAllUsers();
  if (existingUsers.length > 0) {
    throw new Error("Admin registration is no longer available. An admin account already exists.");
  }

  if (!firstName || !lastName || !email) {
    throw new Error("First name, last name, and email are required.");
  }

  if (!/\S+@\S+\.\S+/.test(email)) {
    throw new Error("Invalid email format");
  }

  // Check if email already used (should not happen since DB is empty from check above, but defensive)
  let user = await userRepository.getUserByField("email", email);
  if (user) {
    throw new Error("Email already registered. Please use a different email.");
  }

  // US-003: First admin gets invitation link flow - no password yet, will be set via setup link
  user = await userRepository.createUser({
    firstName,
    lastName,
    username,
    email,
    passwordHash: null,
    role: "admin",
    isActive: false,
  });

  if (!user) {
    throw new Error("Failed to create user");
  }

  try {
    // Generate invitation token instead of OTP (US-003, US-005)
    const plainToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashValue(plainToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

    await invitationTokenRepository.createInvitationToken({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const setupUrl = `${APP_BASE_URL}/setup-password?token=${plainToken}`;
    const emailContent = inviteEmailTemplate({
      setupUrl,
      expiresHours: INVITE_EXPIRY_HOURS,
    });

    const sent = await sendMail({
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (!sent) {
      await userRepository.deleteUser(user.id).catch(() => null);
      throw new Error("Failed to send invitation email. User creation rolled back.");
    }
  } catch (error) {
    await userRepository.deleteUser(user.id).catch(() => null);
    throw new Error(`Failed to send invitation email. ${error.message}`);
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

  const result = await verifyAdminSignupOtp({ email: user.email, otp });

  if (!result || !result.verified) {
    return result;
  }

  // return user info along with verification result
  const updatedUser = await userRepository.getUserByField('id', result.userId);

  // US-064: Auto-create attendance log on first login of the day (employee/admin only)
  // Subsequent logins on the same day are silently ignored.
  if (updatedUser && (updatedUser.role === 'employee' || updatedUser.role === 'admin')) {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const existingLogs = await attendanceLogLogic.getAttendanceLogByField('userId', updatedUser.id);
      const todayLog = Array.isArray(existingLogs)
        ? existingLogs.find((log) => log.date && log.date.toISOString().split('T')[0] === todayStr)
        : null;

      if (!todayLog) {
        // First login of the day — create attendance record
        await attendanceLogLogic.createAttendanceLog({
          userId: updatedUser.id,
          loginTimestamp: now.toISOString(),
          date: `${todayStr}T00:00:00.000Z`,
        });
      }
    } catch (attendanceErr) {
      // Don't block login if attendance logging fails (e.g. no default shift configured yet)
      console.warn('Auto-attendance log skipped:', attendanceErr.message);
    }
  }

  return {
    verified: true,
    userId: updatedUser.id,
    firstName: updatedUser.firstName,
    lastName: updatedUser.lastName,
    username: updatedUser.username,
    email: updatedUser.email,
    role: updatedUser.role,
    isActive: updatedUser.isActive,
  };
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

  // US-004: Allow creating employees, clients, AND admins (with validation)
  const validRoles = ["employee", "client", "admin"];
  if (!validRoles.includes(role)) {
    throw new Error(
      "Role must be employee, client, or admin.",
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

const getSetupPasswordPreview = async ({ token }) => {
  if (!token) {
    throw new Error('Missing setup token.');
  }

  const tokenHash = hashValue(token);
  const tokenRecord = await invitationTokenRepository.getValidTokenByHashWithUser(tokenHash);

  if (!tokenRecord || !tokenRecord.user) {
    throw new Error('Invalid or expired setup token.');
  }

  const { user } = tokenRecord;

  return {
    userId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    role: user.role,
  };
};


const resetPasswordForUser = async ({ adminId, userId }) => {
  if (!adminId || !userId) {
    throw new Error("adminId and userId are required.");
  }

  // Validate the requesting admin
  const admin = await userRepository.getUserByField("id", adminId);
  if (!admin || admin.role !== "admin" || !admin.isActive) {
    throw new Error("Only an active admin can trigger a password reset.");
  }

  // Find the target user
  const targetUser = await userRepository.getUserByField("id", userId);
  if (!targetUser) {
    throw new Error("Target user not found.");
  }

  // Invalidate any existing unused tokens for the user
  await invitationTokenRepository.invalidateUnusedUserTokens(targetUser.id);

  // Create a new reset token
  const plainToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashValue(plainToken);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await invitationTokenRepository.createInvitationToken({
    userId: targetUser.id,
    tokenHash,
    expiresAt,
  });

  const setupUrl = `${APP_BASE_URL}/setup-password?token=${plainToken}`;
  const emailContent = resetPasswordEmailTemplate({
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
    throw new Error("Failed to send password reset email.");
  }

  return { reset: true, userId: targetUser.id, email: targetUser.email };
};


/**
 * US-009: Self-service "Forgot Password" flow.
 * User provides their email → server sends a fresh reset link.
 *
 * Security note: We always return the same success response whether
 * the email exists or not. This prevents email enumeration attacks
 * (an attacker probing which emails are registered in the system).
 */
const forgotPassword = async ({ email }) => {
  if (!email) {
    throw new Error("Email is required.");
  }

  if (!/\S+@\S+\.\S+/.test(email)) {
    throw new Error("Invalid email format.");
  }

  // Look up the user — but do NOT reveal whether they exist
  const user = await userRepository.getUserByField("email", email);

  // Silently succeed if the user doesn't exist (prevents enumeration)
  if (!user) {
    return { sent: true };
  }

  // Invalidate any old unused tokens so stale links stop working
  await invitationTokenRepository.invalidateUnusedUserTokens(user.id);

  // Generate a fresh token
  const plainToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashValue(plainToken);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  await invitationTokenRepository.createInvitationToken({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const setupUrl = `${APP_BASE_URL}/setup-password?token=${plainToken}`;
  const emailContent = resetPasswordEmailTemplate({
    setupUrl,
    expiresHours: INVITE_EXPIRY_HOURS,
  });

  await sendMail({
    to: user.email,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
  });

  // Always return sent: true — do NOT reveal email-not-found here
  return { sent: true };
};

module.exports = {
  authenticateUser,
  verifyOTP,
  requestAdminSignupOtp,
  verifyAdminSignupOtp,
  inviteUserByAdmin,
  setupPasswordWithToken,
  resetPasswordForUser,
  forgotPassword,
  getSetupPasswordPreview,
};
