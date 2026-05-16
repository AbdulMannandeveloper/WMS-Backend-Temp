const authLogic = require('../logic/auth.logic');

const loginUser = async (req, res) => {
    try {
        const userId = await authLogic.authenticateUser(req.body.identifier, req.body.password);
        res.status(200).json({ message: 'Login successful. OTP sent to email.', userId });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const verifyOTP = async (req, res) => {
    try {
        const result = await authLogic.verifyOTP(req.body.userId, req.body.otp);
        res.status(200).json({ message: 'OTP verified.', ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const requestAdminSignupOtp = async (req, res) => {
    try {
        const result = await authLogic.requestAdminSignupOtp(req.body);
        res.status(200).json({
            message: 'OTP sent to email. Please verify to complete signup.',
            ...result,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const verifyAdminSignupOtp = async (req, res) => {
    try {
        const result = await authLogic.verifyAdminSignupOtp(req.body);
        res.status(200).json({ message: 'Admin signup verified successfully.', ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const inviteUserByAdmin = async (req, res) => {
    try {
        const result = await authLogic.inviteUserByAdmin(req.body);
        res.status(201).json({
            message: 'Invitation sent successfully.',
            ...result,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const setupPasswordWithToken = async (req, res) => {
    try {
        const result = await authLogic.setupPasswordWithToken(req.body);
        res.status(200).json({ message: 'Password set successfully.', ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

module.exports = {
    loginUser,
    verifyOTP,
    requestAdminSignupOtp,
    verifyAdminSignupOtp,
    inviteUserByAdmin,
    setupPasswordWithToken,
};