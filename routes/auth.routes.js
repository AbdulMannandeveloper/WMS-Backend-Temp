const express = require('express');

const {
	loginUser,
	verifyOTP,
	requestAdminSignupOtp,
	verifyAdminSignupOtp,
	inviteUserByAdmin,
	setupPasswordWithToken,
} = require('../controllers/auth.controller');

const router = express.Router();

router.post('/login', loginUser);
router.post('/verify-otp', verifyOTP);

router.post('/admin-signup/request-otp', requestAdminSignupOtp);
router.post('/admin-signup/verify-otp', verifyAdminSignupOtp);

router.post('/admin/users/invite', inviteUserByAdmin);
router.post('/setup-password', setupPasswordWithToken);

module.exports = router;