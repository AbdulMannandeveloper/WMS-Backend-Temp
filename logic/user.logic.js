const userRepository = require('../repositories/user.repository');
const authLogic = require('./auth.logic');
const invitationTokenRepository = require("../repositories/invitation-token.repository");

const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { sendMail } = require('../utils/mailer');
const { inviteEmailTemplate } = require('../utils/emailTemplates');

const SALT_ROUNDS = 10;
const INVITE_EXPIRY_HOURS = Number(process.env.INVITE_EXPIRY_HOURS || 24);
const APP_BASE_URL = process.env.APP_BASE_URL || "https://myapp.com";

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const addNewUser = async (userData) => {
    // Admin verification: Only an active admin can add new users
    if (!userData.adminId) {
        throw new Error("adminId is required to add a new user.");
    }
    const adminUser = await userRepository.getUserByField("id", userData.adminId);
    if (!adminUser || adminUser.role !== "admin" || !adminUser.isActive) {
        throw new Error("Only an active admin can add new users.");
    }

    // Remove adminId from userData before creating the user
    delete userData.adminId;

    // Creating a new user with just firstName, lastName, and email
    if (!userData.firstName || !userData.lastName || !userData.email) {
        throw new Error("First and last names, and email are required to register a user");
    }
    
    if (!/\S+@\S+\.\S+/.test(userData.email)) {
        throw new Error("Invalid email format");
    }

    const existingUser = await userRepository.getUserByField('email', userData.email);
    if (existingUser) {
        throw new Error("A user with this email already exists");
    }
    
    const newUser = await userRepository.createUser(userData);
    
    if (newUser) {
        let email_sent = false;
        // Send an email notification to the new user (this is a placeholder, implement your email sending logic here)
        // console.log(`Email sent to ${newUser.email}: Your account for WMS has been created. Please visit the link below to complete your registration and activate your account.`);

        // Create link for user to complete registration

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

        email_sent = await sendMail({
            to: newUser .email,
            subject: emailContent.subject,
            html: emailContent.html,
            text: emailContent.text,
        });

        if (!email_sent) {
            await userRepository.deleteUser(newUser.id);
            throw new Error("Failed to send email notification. User creation rolled back.");
        }
    } else {
        throw new Error("Failed to create user");
    }
    
    // Rollback the user creation if email sending fails

    return newUser;
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

    return await userRepository.updateUser(email, { registrationData });
};

const getAllUsers = async () => {
    return await userRepository.getAllUsers();
};

const getUserByEmail = async (email) => {
    return await userRepository.getUserByField('email', email);
};

const updateUser = async (email, updateData) => {
    const user = await userRepository.getUserByField('email', email);
    if (!user) {
        throw new Error("User not found");
    }

    if (updateData.email && !/\S+@\S+\.\S+/.test(updateData.email)) {
        throw new Error("Invalid email format");
    }

    return await userRepository.updateUser(user.id, updateData);
};

const deleteUser = async (email) => {
    const user = await userRepository.getUserByField('email', email);
    if (!user) {
        throw new Error("User not found");
    }
    return await userRepository.deleteUser(user.id);
};

module.exports = { addNewUser, getAllUsers, getUserByEmail, updateUser, completeUserRegistration, deleteUser };