const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true },
    role: { type: String, enum: ['user', 'ai'], required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    quickReplies: [{ type: String }],
    bookingStep: { type: String, default: null },
  },
  { _id: false }
);

const chatHistorySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    messages: [chatMessageSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatHistory', chatHistorySchema);

