'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/students/profile
router.get('/profile', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const profile = db.prepare('SELECT id, email, name, avatar, role, bio, location, phone, timezone, is_verified FROM users WHERE id = ?').get(user.id);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/students/profile
router.patch('/profile', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { name, bio, location, phone, timezone } = req.body;
    db.prepare('UPDATE users SET name = ?, bio = ?, location = ?, phone = ?, timezone = ? WHERE id = ?')
      .run(name || user.name, bio, location, phone, timezone || 'UTC', user.id);
    const updated = db.prepare('SELECT id, email, name, avatar, role, bio, location, phone, timezone FROM users WHERE id = ?').get(user.id);
    req.session.user = updated;
    res.json({ profile: updated });
  } catch (err) {
    console.error('[students/profile]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/students/bookmarks
router.get('/bookmarks', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const bookmarks = db.prepare(`
      SELECT tp.id, tp.headline, tp.subjects, tp.hourly_rate, tp.avg_rating, tp.review_count,
             tp.teaching_mode, u.name, u.avatar, u.location
      FROM bookmarks b
      JOIN tutor_profiles tp ON tp.id = b.tutor_id
      JOIN users u ON u.id = tp.user_id
      WHERE b.student_id = ?
      ORDER BY b.created_at DESC
    `).all(user.id);
    res.json({ bookmarks });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
