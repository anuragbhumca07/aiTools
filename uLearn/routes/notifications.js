'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/notifications
router.get('/', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const notifications = db.prepare(`
      SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(user.id);
    const unread = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).c;
    res.json({ notifications, unread });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/notifications/read — mark all read
router.patch('/read', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
