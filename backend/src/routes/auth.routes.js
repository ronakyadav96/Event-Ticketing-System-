const express = require('express');
const router = express.Router();
const { register, login, verifyEmail, resendOtp, testEmail } = require('../controllers/auth.controller');

router.post('/register', register);
router.post('/login', login);
router.get('/verify-otp', verifyEmail);
router.post('/verify-otp', verifyEmail);
router.post('/resend-otp', resendOtp);
router.post('/test-email', testEmail);

module.exports = router;
