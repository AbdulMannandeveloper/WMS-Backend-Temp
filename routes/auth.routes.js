const express = require('express');
const { authorizeRoles } = require('../middlewares/authorize');
// Shared factory: same Redis store as the global limiter, same test behaviour.
const { authLimiter: authLimiterFactory } = require('../middlewares/rateLimit');

const authLimiter = authLimiterFactory();

const {
	loginUser,
	verifyOTP,
	setupPasswordPreview,
	requestAdminSignupOtp,
	inviteUserByAdmin,
	setupPasswordWithToken,
	resetPasswordForUser,
	forgotPassword,
	refreshSession,
	logout,
	logoutEverywhere,
} = require('../controllers/auth.controller');

const router = express.Router();

router.post('/login', authLimiter, loginUser);
router.post('/verify-otp', authLimiter, verifyOTP);

// Session lifecycle. Refresh is rate limited like the other credential
// endpoints — it accepts a bearer-equivalent secret from the cookie.
router.post('/refresh', authLimiter, refreshSession);
router.post('/logout', logout);
router.post('/logout-all', authorizeRoles(), logoutEverywhere);

router.post('/admin-signup/request-otp', authLimiter, requestAdminSignupOtp);

router.post('/admin/users/invite', authorizeRoles('admin'), inviteUserByAdmin);

router.post('/forgot-password', authLimiter, forgotPassword);

router.post('/setup-password', setupPasswordWithToken);
router.get('/setup-password/preview', setupPasswordPreview);

router.post('/admin/users/reset-password', authorizeRoles('admin'), resetPasswordForUser);

module.exports = router;
