'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/conversations — my conversations
router.get('/conversations', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const convos = db.prepare(`
      SELECT c.id, c.last_message_at,
        CASE WHEN c.participant1_id = ? THEN c.participant2_id ELSE c.participant1_id END AS other_id,
        u.name AS other_name, u.avatar AS other_avatar, u.role AS other_role,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) AS unread_count
      FROM conversations c
      JOIN users u ON u.id = CASE WHEN c.participant1_id = ? THEN c.participant2_id ELSE c.participant1_id END
      WHERE c.participant1_id = ? OR c.participant2_id = ?
      ORDER BY c.last_message_at DESC
    `).all(user.id, user.id, user.id, user.id, user.id);
    res.json({ conversations: convos });
  } catch (err) {
    console.error('[conversations]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/conversations/:id/messages — paginated messages
router.get('/conversations/:id/messages', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const convoId = req.params.id;
    // Check participant
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND (participant1_id = ? OR participant2_id = ?)').get(convoId, user.id, user.id);
    if (!convo) return res.status(403).json({ error: 'Access denied' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const messages = db.prepare(`
      SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(convoId, limit, offset);

    // Mark as read
    db.prepare('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?').run(convoId, user.id);

    res.json({ messages: messages.reverse(), page });
  } catch (err) {
    console.error('[messages]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/conversations — start or get conversation
router.post('/conversations', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { other_id } = req.body;
    if (!other_id) return res.status(400).json({ error: 'other_id required' });

    const p1 = Math.min(user.id, parseInt(other_id));
    const p2 = Math.max(user.id, parseInt(other_id));

    let convo = db.prepare('SELECT * FROM conversations WHERE participant1_id = ? AND participant2_id = ?').get(p1, p2);
    if (!convo) {
      const result = db.prepare('INSERT INTO conversations (participant1_id, participant2_id) VALUES (?, ?)').run(p1, p2);
      convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
    }
    res.json({ conversation: convo });
  } catch (err) {
    console.error('[conversations/create]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/messages — send message (also emits via socket)
router.post('/messages', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { conversation_id, content } = req.body;
    if (!conversation_id || !content?.trim()) return res.status(400).json({ error: 'conversation_id and content required' });

    // Verify participant
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND (participant1_id = ? OR participant2_id = ?)').get(conversation_id, user.id, user.id);
    if (!convo) return res.status(403).json({ error: 'Access denied' });

    const result = db.prepare('INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)').run(conversation_id, user.id, content.trim());
    db.prepare('UPDATE conversations SET last_message_at = unixepoch() WHERE id = ?').run(conversation_id);

    const message = db.prepare('SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(result.lastInsertRowid);

    // Emit via socket if available
    const io = req.app.get('io');
    if (io) {
      const recipientId = convo.participant1_id === user.id ? convo.participant2_id : convo.participant1_id;
      io.to(`user:${recipientId}`).emit('new_message', message);
      io.to(`user:${user.id}`).emit('message_sent', message);
    }

    // Notification for recipient
    const recipientId = convo.participant1_id === user.id ? convo.participant2_id : convo.participant1_id;
    db.prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)').run(
      recipientId, 'message', `New message from ${user.name}`, content.trim().substring(0, 100), '/messages.html'
    );

    res.status(201).json({ message });
  } catch (err) {
    console.error('[messages/send]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/messages/read/:conversationId
router.patch('/messages/read/:conversationId', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    db.prepare('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?').run(req.params.conversationId, user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
