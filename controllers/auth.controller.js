const {
    refreshCookieOptions,
    REFRESH_COOKIE_NAME,
    signRefreshToken,
} = require('../utils/jwt');

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

        // The refresh token goes in an httpOnly cookie, unreachable from
        // JavaScript. Only the short-lived access token is handed to the client,
        // and it is held in memory rather than localStorage.
        if (result?.verified && result.user) {
            res.cookie(
                REFRESH_COOKIE_NAME,
                signRefreshToken(result.user),
                refreshCookieOptions(),
            );
        }
        const { user, ...body } = result || {};
        res.status(200).json({ message: 'OTP verified.', ...body });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const refreshSession = async (req, res) => {
    try {
        const { accessToken, refreshToken, user } = await authLogic.refreshSession(
            req.cookies?.[REFRESH_COOKIE_NAME],
        );
        // Re-issued so the cookie's lifetime slides forward while someone keeps
        // working. This is NOT per-token revocation: a stateless JWT minted in
        // the same second is byte-identical, so a stolen refresh token is ended
        // by bumping tokenVersion (logout-all, password reset, deactivation),
        // not by this.
        res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
        res.status(200).json({
            token: accessToken,
            userId: user.id,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
        });
    } catch (err) {
        res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
        res.status(401).json({ error: err.message });
    }
};

/** This device only. The access token expires on its own within minutes. */
const logout = async (req, res) => {
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    res.status(200).json({ message: 'Signed out.' });
};

/** Every device — for "I think I have been compromised". */
const logoutEverywhere = async (req, res) => {
    try {
        await authLogic.revokeUserSessions(req.user.id);
        res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
        res.status(200).json({ message: 'Signed out on all devices.' });
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
    refreshSession,
    logout,
    logoutEverywhere,
    setupPasswordPreview,
    requestAdminSignupOtp,
    inviteUserByAdmin,
    setupPasswordWithToken,
    resetPasswordForUser,
    forgotPassword,
};