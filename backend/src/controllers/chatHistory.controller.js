// src/controllers/chatHistory.controller.js
// Handles retrieval, synchronization, and deletion of user chat history.

const mongoose = require('mongoose');
const ChatHistory = require('../models/ChatHistory');

exports.getChatHistory = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(userId)) {
      try {
        const history = await ChatHistory.findOne({ user: userId });
        if (history && Array.isArray(history.messages)) {
          return res.json({
            success: true,
            messages: history.messages,
            updatedAt: history.updatedAt,
          });
        }
      } catch (dbErr) {
        // Fall through to empty history if DB query fails
      }
    }

    return res.json({ success: true, messages: [] });
  } catch (err) {
    console.error('Error fetching chat history:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch chat history' });
  }
};

exports.saveChatHistory = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ success: false, message: 'Messages must be an array' });
    }

    // Sanitize incoming messages: keep strictly lightweight data, discard bulky blobs (events, posters, images)
    const sanitizedMessages = messages
      .slice(-80) // Keep at most 80 most recent messages
      .filter((m) => m && (m.role === 'user' || m.role === 'ai') && typeof m.text === 'string')
      .map((m) => ({
        id: typeof m.id === 'number' ? m.id : Date.now(),
        role: m.role,
        text: String(m.text || '').slice(0, 4000), // Enforce reasonable per-message text limit
        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        quickReplies: Array.isArray(m.quickReplies)
          ? m.quickReplies.slice(0, 5).map((q) => String(q).slice(0, 50))
          : [],
        bookingStep: m.bookingStep ? String(m.bookingStep).slice(0, 30) : null,
      }));

    let updatedAt = new Date();

    // If MongoDB is available and userId is a valid ObjectId, persist optionally
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(userId)) {
      try {
        const history = await ChatHistory.findOneAndUpdate(
          { user: userId },
          { $set: { messages: sanitizedMessages } },
          { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
        );
        if (history?.updatedAt) {
          updatedAt = history.updatedAt;
        }
      } catch (dbErr) {
        // Chat-history DB persistence is optional; do not fail the request
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Chat history synced successfully',
      messageCount: sanitizedMessages.length,
      updatedAt,
    });
  } catch (err) {
    console.error('Error saving chat history:', err);
    return res.status(500).json({ success: false, message: 'Failed to save chat history' });
  }
};

exports.deleteChatHistory = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(userId)) {
      try {
        await ChatHistory.findOneAndDelete({ user: userId });
      } catch (dbErr) {
        // Ignore DB clear errors
      }
    }

    return res.json({ success: true, message: 'Chat history cleared successfully' });
  } catch (err) {
    console.error('Error clearing chat history:', err);
    return res.status(500).json({ success: false, message: 'Failed to clear chat history' });
  }
};

