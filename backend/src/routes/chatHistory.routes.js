const express = require('express');
const router = express.Router();
const chatHistoryController = require('../controllers/chatHistory.controller');
const { protect } = require('../middlewares/auth.middleware');

// Route-specific JSON parser with 200kb limit and explicit 413 PayloadTooLarge handling
const chatHistoryParser = (req, res, next) => {
  express.json({ limit: '200kb' })(req, res, (err) => {
    if (err) {
      if (err.type === 'entity.too.large' || err.status === 413) {
        return res.status(413).json({
          success: false,
          message: 'Chat history payload too large. Please send a lightweight message payload.',
        });
      }
      return res.status(400).json({ success: false, message: 'Invalid JSON payload' });
    }
    next();
  });
};

// GET /api/chat-history - Fetch chat history for logged-in user
router.get('/', protect, chatHistoryController.getChatHistory);

// POST /api/chat-history - Save / sync lightweight chat history for logged-in user
router.post('/', protect, chatHistoryParser, chatHistoryController.saveChatHistory);

// DELETE /api/chat-history - Clear chat history for logged-in user
router.delete('/', protect, chatHistoryController.deleteChatHistory);

module.exports = router;
