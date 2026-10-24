const jwt = require('jsonwebtoken');
const User = require('../models/User');

const mongoose = require('mongoose');

// ========================
// PROTECT (Verify Token)
// ========================
const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization) {
      const authHeader = req.headers.authorization.trim();
      if (/^Bearer\s+/i.test(authHeader)) {
        token = authHeader.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
      }
    }

    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const userId = decoded.id || decoded._id || decoded.userId || decoded.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    let user = null;
    try {
      if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId).select('-password');
      }
    } catch (dbErr) {
      // Ignore database lookup errors; fallback to decoded JWT token
    }

    req.user = user || {
      _id: userId,
      id: userId,
      role: decoded.role || 'user',
      email: decoded.email,
      name: decoded.name,
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// ========================
// AUTHORIZE ROLES (RBAC)
// ========================
const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    next();
  };
};

module.exports = { protect, authorizeRoles };
