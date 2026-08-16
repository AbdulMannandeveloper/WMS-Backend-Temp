const express = require('express');
const rateLimit = require('express-rate-limit');
const { authorizeRoles } = require('../middlewares/authorize');

const buildAuthLimiter = () => {
	const options = {
		windowMs: 15 * 60 * 1000,
		max: 10,
		standardHeaders: true,
		legacyHeaders: false,
		message: { error: 'Too many attempts. Please try again later.' },
	};

	if (process.env.REDIS_URL) {
		try {
			const Redis = require('ioredis');
			const { RedisStore } = require('rate-limit-redis');
			const client = new Redis(process.env.REDIS_URL, {
				maxRetriesPerRequest: 3,
			});
			options.store = new RedisStore({
				sendCommand: (...args) => client.call(...args),
				prefix: 'rl:auth:',
			});
			console.log('[RateLimit] Auth limiter using Redis store');
		} catch (err) {
			console.error('[RateLimit] Redis store unavailable, using memory:', err.message);
		}
	}

	return rateLimit(options);
};

const authLimiter = buildAuthLimiter();

const {
	loginUser,
	verifyOTP,
	setupPasswordPreview,
	requestAdminSignupOtp,
	inviteUserByAdmin,
	setupPasswordWithToken,
	resetPasswordForUser,
	forgotPassword,
} = require('../controllers/auth.controller');

const router = express.Router();

router.post('/login', authLimiter, loginUser);
router.post('/verify-otp', authLimiter, verifyOTP);

router.post('/admin-signup/request-otp', authLimiter, requestAdminSignupOtp);

router.post('/admin/users/invite', authorizeRoles('admin'), inviteUserByAdmin);

router.post('/forgot-password', authLimiter, forgotPassword);

router.post('/setup-password', setupPasswordWithToken);
router.get('/setup-password/preview', setupPasswordPreview);

router.post('/admin/users/reset-password', authorizeRoles('admin'), resetPasswordForUser);

module.exports = router;
