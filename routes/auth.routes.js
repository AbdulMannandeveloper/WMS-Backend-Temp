const express = require('express');

const {
	loginUser,
	verifyOTP,
	requestAdminSignupOtp,
	inviteUserByAdmin,
	setupPasswordWithToken,
	resetPasswordForUser,
	forgotPassword,
} = require('../controllers/auth.controller');

const router = express.Router();

router.post('/login', loginUser);
router.post('/verify-otp', verifyOTP);

// US-001, US-002, US-003, US-005: First admin registration with invitation link
router.post('/admin-signup/request-otp', requestAdminSignupOtp);

// DEPRECATED: /admin-signup/verify-otp removed
// First admin now uses /setup-password endpoint (same as other users)
// router.post('/admin-signup/verify-otp', verifyAdminSignupOtp);

// US-004, US-005: Admin invites employees, clients, or other admins
router.post('/admin/users/invite', inviteUserByAdmin);

// US-009: Self-service — user requests a fresh password reset link by email
router.post('/forgot-password', forgotPassword);

// US-005, US-009: Set password via invitation token (initial setup AND password reset)
router.post('/setup-password', setupPasswordWithToken);

// US-008: Admin triggers a reset-password email for a specific user
// US-009: User completes password reset via the secure link (reuses /setup-password)
router.post('/admin/users/reset-password', resetPasswordForUser);

module.exports = router;