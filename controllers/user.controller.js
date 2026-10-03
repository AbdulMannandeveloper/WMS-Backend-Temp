const userLogic = require('../logic/user.logic');
const { dependentsBody } = require('../utils/dependents');

const addNewUser = async (req, res) => {
    try {
        // The acting admin is taken from the verified session, never the body/headers.
        const result = await userLogic.addNewUser({ ...req.body, adminId: req.user.id });
        res.status(201).json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

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
        const result = await userLogic.updateUser(req.params.id, req.body, req.user.id);
        res.status(200).json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// What would stop a delete, asked before the admin presses it.
const getUserDependents = async (req, res) => {
    try {
        const { report } = await userLogic.getUserDependents(req.params.id);
        res.status(200).json(report);
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
};

const deleteUser = async (req, res) => {
    try {
        // Was the deleted row itself, password hash included.
        const { name } = await userLogic.deleteUser(req.params.id, req.user.id);
        res.status(200).json({ message: `${name} was deleted.` });
    } catch (err) {
        if (err.code === 'HAS_DEPENDENTS') {
            return res.status(409).json(dependentsBody(err));
        }
        res.status(err.status || 400).json({ error: err.message });
    }
};

module.exports = { addNewUser, getAllUsers, getUserByEmail, updateUser, getUserDependents, deleteUser };
