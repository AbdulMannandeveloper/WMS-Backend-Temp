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

const setupPasswordPreview = async (req, res) => {
    try {
        const result = await authLogic.getSetupPasswordPreview(req.query);
        res.status(200).json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const requestAdminSignupOtp = async (req, res) => {
    try {
        // US-001, US-002, US-003, US-005: First admin registration with invitation link
        const result = await authLogic.requestAdminSignupOtp(req.body);
        res.status(200).json({
            message: 'Invitation link sent to email. Please verify and set password to complete signup.',
            ...result,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// DEPRECATED: verifyAdminSignupOtp no longer needed
// First admin now uses invitation token flow (same as other users)
// const verifyAdminSignupOtp = async (req, res) => {
//     try {
//         const result = await authLogic.verifyAdminSignupOtp(req.body);
//         res.status(200).json({ message: 'Admin signup verified successfully.', ...result });
//     } catch (err) {
//         res.status(400).json({ error: err.message });
//     }
// };

const inviteUserByAdmin = async (req, res) => {
    try {
        // US-004, US-005: Admin invites employees, clients, or other admins.
        // The acting admin is taken from the verified session, never the body.
        const result = await authLogic.inviteUserByAdmin({ ...req.body, adminId: req.user.id });
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

// US-008: Admin triggers a reset-password email for a specific user
const resetPasswordForUser = async (req, res) => {
    try {
        // The acting admin is taken from the verified session, never the body/headers.
        const result = await authLogic.resetPasswordForUser({
            userId: req.body.userId,
            adminId: req.user.id,
        });
        res.status(200).json({ message: 'Password reset email sent successfully.', ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// US-009: Self-service forgot-password — user requests a fresh reset link
const forgotPassword = async (req, res) => {
    try {
        // Always return 200 regardless of whether the email exists.
        // This prevents email enumeration (attacker cannot tell if an
        // email is registered by observing different HTTP responses).
        const result = await authLogic.forgotPassword(req.body);
        res.status(200).json({
            message: 'If an account with that email exists, a password reset link has been sent.',
            ...result,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

module.exports = {
    loginUser,
    verifyOTP,
    setupPasswordPreview,
    requestAdminSignupOtp,
    inviteUserByAdmin,
    setupPasswordWithToken,
    resetPasswordForUser,
    forgotPassword,
};