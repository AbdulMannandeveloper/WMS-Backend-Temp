const userLogic = require('../logic/user.logic');

// DEPRECATED: User creation moved to /auth/admin/users/invite endpoint
// Kept for backward compatibility - redirect traffic to auth endpoint
// const addNewUser = async (req, res) => {
//     try {
//         const loggedInUserId = (req.user && req.user.id) || req.header('x-user-id');
//         const result = await userLogic.addNewUser({ ...req.body, adminId: loggedInUserId });
//         res.status(201).json(result);
//     } catch (err) {
//         res.status(400).json({ error: err.message });
//     }
// };

const getAllUsers = async (req, res) => {
    try {
        const users = await userLogic.getAllUsers();
        res.status(200).json(users);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const getUserByEmail = async (req, res) => {
    try {
        const user = await userLogic.getUserByEmail(req.params.email);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        res.status(200).json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const updateUser = async (req, res) => {
    try {
        const result = await userLogic.updateUser(req.params.id, req.body);
        res.status(200).json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const deleteUser = async (req, res) => {
    try {
        const result = await userLogic.deleteUser(req.params.id);
        res.status(200).json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

module.exports = { getAllUsers, getUserByEmail, updateUser, deleteUser };