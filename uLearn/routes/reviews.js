'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/reviews/:tutorId
router.get('/:tutorId', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;

    const reviews = db.prepare(`
      SELECT r.*, u.name AS student_name, u.avatar AS student_avatar
      FROM reviews r
      JOIN users u ON u.id = r.student_id
      WHERE r.tutor_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.tutorId, limit, offset);

    const { total } = db.prepare('SELECT COUNT(*) as total FROM reviews WHERE tutor_id = ?').get(req.params.tutorId);

    // Rating distribution
    const distribution = db.prepare(`
      SELECT rating, COUNT(*) as count FROM reviews WHERE tutor_id = ? GROUP BY rating
    `).all(req.params.tutorId);

    res.json({ reviews, total, page, pages: Math.ceil(total / limit), distribution });
  } catch (err) {
    console.error('[reviews/list]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/reviews
router.post('/', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { tutor_id, rating, comment } = req.body;
    if (!tutor_id || !rating) return res.status(400).json({ error: 'tutor_id and rating required' });

    const ratingNum = parseInt(rating);
    if (ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

    // Check for prior session
    const tutor = db.prepare('SELECT id FROM tutor_profiles WHERE id = ?').get(tutor_id);
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });

    try {
      const result = db.prepare('INSERT INTO reviews (tutor_id, student_id, rating, comment) VALUES (?, ?, ?, ?)').run(tutor_id, user.id, ratingNum, comment);

      // Update tutor avg_rating & review_count
      const stats = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE tutor_id = ?').get(tutor_id);
      db.prepare('UPDATE tutor_profiles SET avg_rating = ?, review_count = ? WHERE id = ?').run(
        Math.round(stats.avg * 10) / 10, stats.cnt, tutor_id
      );

      // Update FTS
      const tp = db.prepare('SELECT tp.*, u.name, u.bio, u.location FROM tutor_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.id = ?').get(tutor_id);
      db.prepare('DELETE FROM tutor_search WHERE tutor_id = ?').run(tutor_id);
      db.prepare('INSERT INTO tutor_search (tutor_id, name, headline, subjects, bio, location) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tutor_id, tp.name, tp.headline, tp.subjects, tp.bio, tp.location);

      // Notify tutor
      const tutorProfile = db.prepare('SELECT user_id FROM tutor_profiles WHERE id = ?').get(tutor_id);
      db.prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)').run(
        tutorProfile.user_id, 'review', 'New Review Received',
        `${user.name} left you a ${ratingNum}-star review`, '/dashboard-tutor.html'
      );

      const review = db.prepare('SELECT r.*, u.name AS student_name, u.avatar AS student_avatar FROM reviews r JOIN users u ON u.id = r.student_id WHERE r.id = ?').get(result.lastInsertRowid);
      return res.status(201).json({ review });
    } catch (dupErr) {
      if (dupErr.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'You have already reviewed this tutor' });
      }
      throw dupErr;
    }
  } catch (err) {
    console.error('[reviews/create]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/reviews/:id
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.student_id !== user.id && user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

    db.prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);

    // Recalculate rating
    const stats = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM reviews WHERE tutor_id = ?').get(review.tutor_id);
    db.prepare('UPDATE tutor_profiles SET avg_rating = ?, review_count = ? WHERE id = ?').run(
      stats.avg || 0, stats.cnt, review.tutor_id
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[reviews/delete]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
