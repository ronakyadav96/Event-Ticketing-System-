const express = require('express');
const router = express.Router();
const { register, login, verifyEmail, resendOtp, forgotPassword, resetPassword } = require('../controllers/auth.controller');

router.post('/register', register);
router.post('/login', login);
router.get('/verify-otp', verifyEmail);
router.post('/verify-otp', verifyEmail);
router.post('/resend-otp', resendOtp);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;
