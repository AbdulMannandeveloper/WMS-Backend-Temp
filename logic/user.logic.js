const userRepository = require('../repositories/user.repository');
const authLogic = require('./auth.logic');
const invitationTokenRepository = require("../repositories/invitation-token.repository");

const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { enqueueMail } = require('../utils/mailQueue');
const { invalidateCachedUser } = require('../utils/authUserCache');
const { inviteEmailTemplate } = require('../utils/emailTemplates');

const SALT_ROUNDS = 10;
const INVITE_EXPIRY_HOURS = Number(process.env.INVITE_EXPIRY_HOURS || 24);
const APP_BASE_URL = process.env.APP_BASE_URL || "https://myapp.com";

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Removes the password hash from any user object before it is returned to a
// client, replacing it with a boolean the UI can use to show pending/active.
const sanitizeUser = (user) => {
    if (!user) return user;
    const { passwordHash, ...rest } = user;
    return { ...rest, hasPassword: Boolean(passwordHash) };
};

const addNewUser = async (userData) => {
    // Admin verification: Only an active admin can add new users
    if (!userData.adminId) {
        throw new Error("adminId is required to add a new user.");
    }
    const adminUser = await userRepository.getUserByField("id", userData.adminId);
    if (!adminUser || adminUser.role !== "admin" || !adminUser.isActive) {
        throw new Error("Only an active admin can add new users.");
    }

    // Allowlist the fields a client may set. This prevents mass-assignment of
    // sensitive fields such as passwordHash or isActive. (createUser also forces
    // isActive=false, and the account is activated only via password setup.)
    const allowedRoles = ["employee", "client", "admin"];
    const role = allowedRoles.includes(userData.role) ? userData.role : "employee";
    const safeUserData = {
        firstName: userData.firstName,
        lastName: userData.lastName,
        username: userData.username,
        email: userData.email,
        role,
        passwordHash: null,
    };

    // Creating a new user with just firstName, lastName, and email
    if (!safeUserData.firstName || !safeUserData.lastName || !safeUserData.email) {
        throw new Error("First and last names, and email are required to register a user");
    }

    if (!/\S+@\S+\.\S+/.test(safeUserData.email)) {
        throw new Error("Invalid email format");
    }

    const existingUser = await userRepository.getUserByField('email', safeUserData.email);
    if (existingUser) {
        throw new Error("A user with this email already exists");
    }

    const newUser = await userRepository.createUser(safeUserData);

    if (!newUser) {
        throw new Error("Failed to create user");
    }

    const plainToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashValue(plainToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

    await invitationTokenRepository.createInvitationToken({
        userId: newUser.id,
        tokenHash,
        expiresAt,
    });

    const setupUrl = `${APP_BASE_URL}/setup-password?token=${plainToken}`;
    const emailContent = inviteEmailTemplate({
        setupUrl,
        expiresHours: INVITE_EXPIRY_HOURS,
    });

    enqueueMail({
        to: newUser.email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
    });

    return sanitizeUser(newUser);
};

const completeUserRegistration = async (email, registrationData) => {
    const user = await userRepository.getUserByField('email', email);

    if (!user) {
        throw new Error("User not found");
    }

    const passwordHash = await bcrypt.hash(registrationData.password, SALT_ROUNDS);

    delete registrationData.password; // Remove the plain password from the registrationData object
    registrationData.passwordHash = passwordHash;
    registrationData.isActive = true; // Activate the user account

    const updated = await userRepository.updateUser(user.id, registrationData);
    invalidateCachedUser(user.id);
    return updated;
};

const getAllUsers = async () => {
    const users = await userRepository.getAllUsers();
    return Array.isArray(users) ? users.map(sanitizeUser) : users;
};

const getUserByEmail = async (email) => {
    return sanitizeUser(await userRepository.getUserByField('email', email));
};

const USER_UPDATE_FIELDS = ['firstName', 'lastName', 'username', 'email', 'role', 'isActive'];

const updateUser = async (id, rawUpdateData) => {
    const user = await userRepository.getUserByField('id', id);
    if (!user) {
        throw new Error("User not found");
    }

    // Allowlist updatable fields. passwordHash can never be set through this path;
    // passwords are only ever set via the invitation/reset token flow.
    const updateData = {};
    for (const field of USER_UPDATE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(rawUpdateData, field)) {
            updateData[field] = rawUpdateData[field];
        }
    }

    if (updateData.role && !['employee', 'client', 'admin'].includes(updateData.role)) {
        throw new Error("Invalid role.");
    }

    // Deactivating an account, or moving someone between roles, has to end the
    // sessions they already hold. Without this a deactivated user keeps working
    // until their access token expires, and a demoted admin keeps admin rights
    // in the token they are already carrying.
    const revokes =
        (updateData.isActive === false && user.isActive) ||
        (updateData.role && updateData.role !== user.role);
    if (revokes) {
        updateData.tokenVersion = (user.tokenVersion ?? 0) + 1;
    }

    if (updateData.email && !/\S+@\S+\.\S+/.test(updateData.email)) {
        throw new Error("Invalid email format");
    }

    // Prevent changing active state for users who haven't completed password setup
    if (Object.prototype.hasOwnProperty.call(updateData, 'isActive')) {
        // If user has no passwordHash (not yet set), disallow toggling active state
        if (!user.passwordHash) {
            throw new Error('Cannot change active state until user has completed password setup.');
        }
    }

    const updated = sanitizeUser(await userRepository.updateUser(user.id, updateData));
    invalidateCachedUser(user.id);
    return updated;
};

const deleteUser = async (id) => {
    const user = await userRepository.getUserByField('id', id);
    if (!user) {
        throw new Error("User not found");
    }
    const deleted = await userRepository.deleteUser(user.id);
    invalidateCachedUser(user.id);
    return deleted;
};

module.exports = { addNewUser, getAllUsers, getUserByEmail, updateUser, completeUserRegistration, deleteUser };
