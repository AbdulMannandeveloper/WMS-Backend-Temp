const employeeRepository = require('../repositories/employee.repository');
const userRepository = require('../repositories/user.repository');
const authLogic = require('./auth.logic');
const invitationTokenRepository = require("../repositories/invitation-token.repository");
const clientRepository = require('../repositories/client.repository');
const clientLogic = require('./client.logic');
const auditLogLogic = require('./audit_log.logic');
const { prisma } = require('../lib/prisma');
const { buildReport, assertDeletable } = require('../utils/dependents');

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

    // An employee login without an Employee profile is a person who cannot be
    // assigned any work: shipments reference the profile, not the user, so the
    // operator dropdown is built from profiles. This route created only the
    // login, the Employees page created both, and the result was two employee
    // users with zero profiles and a create-shipment dialog that refused to open
    // because it could find nobody to assign. Created here so the two can never
    // drift apart again; addEmployee remains the richer path for job title,
    // salary and the rest.
    if (newUser.role === "employee") {
        const existingProfile = await employeeRepository.getEmployeeByField(
            "userId",
            newUser.id,
        );
        if (!existingProfile) {
            await employeeRepository.createEmployee({ userId: newUser.id });
        }
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
    await invalidateCachedUser(user.id);
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

/**
 * Refuses to let an admin lock themselves out.
 *
 * Only the acting admin's own account needs guarding: whoever makes the request
 * is an active admin, so as long as it is not themselves they are removing,
 * there is still one left afterwards to undo it.
 *
 * @param {object} target
 * @param {string} [actorUserId]
 * @param {string} doing  e.g. "deactivate", for the message
 */
const assertNotSelf = (target, actorUserId, doing) => {
    if (actorUserId && target.id === actorUserId) {
        throw new Error(`You cannot ${doing} your own account. Ask another admin to do it.`);
    }
};

const updateUser = async (id, rawUpdateData, actorUserId) => {
    const user = await userRepository.getUserByField('id', id);
    if (!user) {
        throw new Error("User not found");
    }

    const losesAdmin =
        (rawUpdateData.isActive === false && user.isActive) ||
        (rawUpdateData.role && rawUpdateData.role !== 'admin' && user.role === 'admin');
    if (losesAdmin) {
        assertNotSelf(user, actorUserId, rawUpdateData.isActive === false ? 'deactivate' : 'demote');
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
    await invalidateCachedUser(user.id);
    return updated;
};

const notFound = () => {
    const err = new Error("User not found");
    err.status = 404;
    return err;
};

/**
 * Everything that still refers to a staff login, for the warning shown before
 * a delete. See utils/dependents.js for what blocking and removedWith mean.
 *
 * Blocking is what the database would refuse anyway, said in words: shipments
 * name the employee who handled them, and stock movements and finalised pay
 * name the person they belong to. The last two are permanent records, so for
 * anyone with either the answer is deactivate, not delete.
 *
 * Attendance, fines and bonuses go with the person. Their audit entries do not:
 * they stay, under the name written to actorName below.
 *
 * A client login is judged by the client's own rules, which it delegates to —
 * deleting one is deleting the client.
 */
const getUserDependents = async (id) => {
    const user = await userRepository.getUserByField('id', id);
    if (!user) {
        throw notFound();
    }

    if (user.role === 'client') {
        const client = await clientRepository.getClientByField('userId', id);
        if (client) {
            const { report } = await clientLogic.getClientDependents(client.id);
            return { user, report };
        }
    }

    const employee = await employeeRepository.getEmployeeByField('userId', id);
    const [shipments, ledgerRows, payrollRecords, attendance, fines, bonuses] = await Promise.all([
        employee ? prisma.shipment.count({ where: { employeeId: employee.id } }) : 0,
        prisma.inventoryLedger.count({ where: { userId: id } }),
        prisma.payrollRecord.count({ where: { userId: id } }),
        prisma.employeeAttendanceLog.count({ where: { userId: id } }),
        prisma.employeeFine.count({ where: { userId: id } }),
        prisma.employeeBonus.count({ where: { userId: id } }),
    ]);

    return {
        user,
        report: buildReport({
            blocking: [
                {
                    key: 'shipments',
                    label: 'Shipments handled by them',
                    count: shipments,
                    where: '/shipments',
                },
                {
                    key: 'ledger',
                    label: 'Stock movements they recorded',
                    count: ledgerRows,
                    note: 'Ledger history is permanent. Deactivate them instead.',
                },
                {
                    key: 'payroll',
                    label: 'Finalised payroll months',
                    count: payrollRecords,
                    note: 'Finalised pay is permanent. Deactivate them instead.',
                },
            ],
            removedWith: [
                { key: 'attendance', label: 'Attendance records', count: attendance },
                { key: 'fines', label: 'Fines', count: fines },
                { key: 'bonuses', label: 'Bonuses', count: bonuses },
            ],
        }),
    };
};

/**
 * Deletes a login and everything that belongs only to it.
 *
 * Refused while getUserDependents reports anything blocking, for yourself, and
 * for the last active admin. The Employee row, attendance, fines and bonuses
 * cascade; audit entries survive with the person's name written onto them.
 *
 * @throws {HasDependentsError} (409) while records still refer to the login
 */
const deleteUser = async (id, actorUserId) => {
    const { user, report } = await getUserDependents(id);
    assertNotSelf(user, actorUserId, 'delete');

    const name = `${user.firstName} ${user.lastName}`.trim() || user.email;
    assertDeletable(name, report, { deactivatable: true });

    if (user.role === 'client') {
        const client = await clientRepository.getClientByField('userId', id);
        if (client) {
            await clientLogic.deleteClient(client.id, actorUserId);
            return { id, name };
        }
    }

    await prisma.$transaction(async (tx) => {
        // Before the delete, while the rows still point at this person.
        await tx.auditLog.updateMany({
            where: { userId: id },
            data: { actorName: `${name} (deleted)`.slice(0, 120) },
        });
        await tx.user.delete({ where: { id } });
    });
    await invalidateCachedUser(id);

    if (actorUserId) {
        await auditLogLogic.createAuditLog(actorUserId, 'DELETE_USER', {
            userId: id,
            name,
            email: user.email,
            role: user.role,
        }).catch((err) => console.error('Audit log error:', err.message));
    }

    return { id, name };
};

module.exports = {
    addNewUser,
    getAllUsers,
    getUserByEmail,
    updateUser,
    completeUserRegistration,
    getUserDependents,
    deleteUser,
};
