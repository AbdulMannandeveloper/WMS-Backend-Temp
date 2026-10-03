const { prisma } = require('../lib/prisma');
const { normaliseEmail, normaliseUsername } = require('../utils/identifiers');

const prismaUser = prisma.user;

const PUBLIC_USER_SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    username: true,
    email: true,
    role: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
};

// Email and username are matched case-insensitively by storing them in one
// spelling (utils/identifiers.js). Doing it here rather than at each caller
// means a new path cannot forget: login, invites, client and employee creation
// and the admin edit screen all write and read through this file.
const NORMALISERS = {
    email: normaliseEmail,
    username: normaliseUsername,
};

const normaliseIdentity = (data) => {
    const out = { ...data };
    for (const [field, normalise] of Object.entries(NORMALISERS)) {
        if (Object.prototype.hasOwnProperty.call(out, field)) {
            out[field] = normalise(out[field]);
        }
    }
    return out;
};

/**
 * Says which identity is taken, instead of Prisma's constraint dump.
 *
 * The callers check email first, but two admins can add the same person at
 * once, and nobody checks username at all. Either way the index has the last
 * word, and this is what it means in words.
 */
const explainClash = (err) => {
    if (err?.code !== 'P2002') return err;
    const target = err.meta?.target;
    const fields = (Array.isArray(target) ? target : [target]).map((f) => String(f ?? ''));
    if (fields.some((f) => f.includes('email'))) {
        return new Error('A user with this email already exists.');
    }
    if (fields.some((f) => f.includes('username'))) {
        return new Error('That username is already taken.');
    }
    return err;
};

const createUser = async (userData) => {
    userData.isActive = false;
    try {
        return await prismaUser.create({
            data: normaliseIdentity(userData),
            // select: PUBLIC_USER_SELECT,
        });
    } catch (err) {
        throw explainClash(err);
    }
}

const getAllUsers = async () => {
    return await prismaUser.findMany({
        // select: PUBLIC_USER_SELECT,
    });
}

const getUserByField = async (field, value) => {
    const normalise = NORMALISERS[field];
    const lookup = normalise ? normalise(value) : value;
    // A blank username normalises to null, and findUnique cannot look up null.
    // Nobody is called nothing, so it is a miss.
    if (normalise && lookup === null) {
        return null;
    }
    return await prismaUser.findUnique({
        where: { [field]: lookup },
        // select: PUBLIC_USER_SELECT,
    });
}

const updateUser = async (id, updateData) => {
    try {
        return await prismaUser.update({
            where: { id },
            data: normaliseIdentity(updateData),
            // select: PUBLIC_USER_SELECT,
        });
    } catch (err) {
        throw explainClash(err);
    }
}

const deleteUser = async (id) => {
    return await prismaUser.delete({
        where: { id },
        // select: PUBLIC_USER_SELECT,
    });
}

module.exports = {
    createUser,
    getAllUsers,
    getUserByField,
    updateUser,
    deleteUser,
}
