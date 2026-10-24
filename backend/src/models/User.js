const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { 
      type: String, 
      trim: true, 
      required: true 
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      required: true,
    },

    // ✅ password should not be returned by default
    password: { 
      type: String, 
      required: true, 
      select: false 
    },

   role: {
  type: String,
  enum: ['user', 'creator', 'superadmin'],
  lowercase: true,
  required: true
},

    // email verification (OTP)
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailOtpHash: {
      type: String,
      default: null,
      select: false,
    },
    emailOtpExpires: {
      type: Date,
      default: null,
      select: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
