const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/mailer');

// helper
function normalizeEmail(v) {
  return (v || '').trim().toLowerCase();
}

function getBaseUrlFromRequest(req) {
  const fromEnv = (process.env.SERVER_URL || process.env.NEXT_PUBLIC_API_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  const protocol = req.protocol || 'http';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

function createEmailOtp() {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const hash = crypto.createHash('sha256').update(otp).digest('hex');

  const minutes = Number(process.env.EMAIL_OTP_TTL_MINUTES || 10);
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  return { otp, hash, expiresAt };
}

function isMailDisabled() {
  return (process.env.MAIL_DISABLED || '').toLowerCase() === 'true';
}

// ================= REGISTER =================
exports.register = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = req.body.password || ''; // ✅ DO NOT trim password
    const role = (req.body.role || '').trim().toLowerCase();

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, password are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Allow only user or creator from frontend
    const allowedRole = role === 'creator' ? 'creator' : 'user';

    const { otp, hash, expiresAt } = createEmailOtp();

    let user = await User.findOne({ email }).select('+emailOtpHash +emailOtpExpires');

    if (user && user.isEmailVerified) {
      return res.status(409).json({ message: 'User already exists' });
    }

    if (!user) {
      user = await User.create({
        name,
        email,
        password: hashedPassword,
        role: allowedRole,
        isEmailVerified: false,
        emailOtpHash: hash,
        emailOtpExpires: expiresAt,
      });
    } else {
      user.name = name;
      user.password = hashedPassword;
      user.role = allowedRole;
      user.isEmailVerified = false;
      user.emailOtpHash = hash;
      user.emailOtpExpires = expiresAt;
      await user.save();
    }

    try {
      const baseUrl = getBaseUrlFromRequest(req);
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        otp,
        baseUrl,
      });
    } catch (mailErr) {
      console.error('EMAIL VERIFY SEND ERROR:', mailErr);
      if (!isMailDisabled()) {
        await User.deleteOne({ _id: user._id });
        return res.status(500).json({
          message: 'Could not send verification email. Please try again.',
        });
      }
    }

    const baseUrl = getBaseUrlFromRequest(req);
    const verifyLink = `${baseUrl.replace(/\/+$/, '')}/api/auth/verify-otp?email=${encodeURIComponent(
      user.email
    )}&otp=${encodeURIComponent(otp)}`;

    return res.status(201).json({
      message: isMailDisabled()
        ? 'OTP generated. Email sending is disabled; use verifyLink or OTP.'
        : 'OTP sent to your email. Please verify to login.',
      verifyLink: isMailDisabled() ? verifyLink : undefined,
      otp: isMailDisabled() ? otp : undefined,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('REGISTER ERROR:', err);

    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'User already exists' });
    }

    return res.status(500).json({ message: 'Registration failed' });
  }
};

// ================= LOGIN =================
exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (!process.env.JWT_SECRET) {
      console.error('❌ JWT_SECRET missing in env');
      return res.status(500).json({ message: 'Server misconfigured (JWT_SECRET missing)' });
    }

    const user = await User.findOne({ email }).select('+password +isEmailVerified');

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const role = String(user.role || '').toLowerCase();
    const bypassVerify = role === 'superadmin' || role === 'admin';
    if (!bypassVerify && !user.isEmailVerified) {
      return res.status(403).json({ message: 'Email not verified' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { 
        id: user._id.toString(), 
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    return res.json({
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ message: 'Login failed' });
  }
};

// ================= VERIFY EMAIL (OTP) =================
exports.verifyEmail = async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email || req.body?.email);
    const otp = (req.query.otp || req.body?.otp || '').toString().trim();

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    const user = await User.findOne({
      email,
      emailOtpHash: otpHash,
      emailOtpExpires: { $gt: new Date() },
    }).select('+emailOtpHash +emailOtpExpires');

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    user.isEmailVerified = true;
    user.emailOtpHash = null;
    user.emailOtpExpires = null;

    await user.save();

    if (req.method === 'GET') {
      return res.send('Email verified successfully. You can now login.');
    }

    return res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('VERIFY EMAIL ERROR:', err);
    return res.status(500).json({ message: 'Email verification failed' });
  }
};

// ================= RESEND OTP =================
exports.resendOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await User.findOne({ email }).select('+emailOtpHash +emailOtpExpires');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isEmailVerified) {
      return res.status(400).json({ message: 'Email already verified' });
    }

    const { otp, hash, expiresAt } = createEmailOtp();
    user.emailOtpHash = hash;
    user.emailOtpExpires = expiresAt;
    await user.save();

    try {
      const baseUrl = getBaseUrlFromRequest(req);
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        otp,
        baseUrl,
      });
    } catch (mailErr) {
      console.error('RESEND OTP EMAIL ERROR:', mailErr);
      if (!isMailDisabled()) {
        return res.status(500).json({
          message: 'Could not send OTP email. Please try again.',
        });
      }
    }

    const baseUrl = getBaseUrlFromRequest(req);
    const verifyLink = `${baseUrl.replace(/\/+$/, '')}/api/auth/verify-otp?email=${encodeURIComponent(
      user.email
    )}&otp=${encodeURIComponent(otp)}`;

    return res.json({
      message: isMailDisabled()
        ? 'OTP regenerated. Email sending is disabled; use verifyLink or OTP.'
        : 'OTP resent to your email.',
      verifyLink: isMailDisabled() ? verifyLink : undefined,
      otp: isMailDisabled() ? otp : undefined,
    });
  } catch (err) {
    console.error('RESEND OTP ERROR:', err);
    return res.status(500).json({ message: 'Resend OTP failed' });
  }
};

// ================= TEST EMAIL (DEV) =================
exports.testEmail = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const { otp } = createEmailOtp();
    const baseUrl = getBaseUrlFromRequest(req);

    await sendVerificationEmail({
      to: email,
      name: 'Test User',
      otp,
      baseUrl,
    });

    return res.json({ message: 'Test email sent (if SMTP is configured).' });
  } catch (err) {
    console.error('TEST EMAIL ERROR:', err);
    return res.status(500).json({ message: 'Test email failed' });
  }
};
