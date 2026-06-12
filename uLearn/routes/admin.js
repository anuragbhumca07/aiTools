'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/admin/stats
router.get('/stats', requireAuth, requireAdmin, (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const totalTutors = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'tutor'").get().c;
    const totalStudents = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;
    const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const sessionsToday = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE scheduled_at >= ? AND status = 'confirmed'").get(todayStart).c;
    const pendingApprovals = db.prepare('SELECT COUNT(*) as c FROM tutor_profiles WHERE is_approved = 0').get().c;
    const totalBookings = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
    const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
    const totalReviews = db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;

    // Revenue estimate
    const revenue = db.prepare("SELECT COALESCE(SUM(price), 0) as total FROM bookings WHERE status = 'completed'").get().total;

    res.json({
      totalUsers, totalTutors, totalStudents, sessionsToday,
      pendingApprovals, totalBookings, totalMessages, totalReviews, revenue
    });
  } catch (err) {
    console.error('[admin/stats]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/users
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { search = '', role = '', page = 1 } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;

    let where = '1=1';
    const params = [];

    if (search) {
      where += ' AND (u.name LIKE ? OR u.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (role) {
      where += ' AND u.role = ?';
      params.push(role);
    }

    const { total } = db.prepare(`SELECT COUNT(*) as total FROM users u WHERE ${where}`).get(...params);
    const users = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.is_active, u.is_verified, u.location, u.created_at, u.last_seen,
        CASE WHEN u.role = 'tutor' THEN tp.avg_rating ELSE NULL END as avg_rating,
        CASE WHEN u.role = 'tutor' THEN tp.total_sessions ELSE NULL END as total_sessions
      FROM users u
      LEFT JOIN tutor_profiles tp ON tp.user_id = u.id
      WHERE ${where}
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `).all(...params);

    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const { role, is_active, is_verified } = req.body;
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
    if (is_active !== undefined) db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id);
    if (is_verified !== undefined) db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(is_verified ? 1 : 0, req.params.id);

    const updated = db.prepare('SELECT id, email, name, role, is_active, is_verified FROM users WHERE id = ?').get(req.params.id);
    res.json({ user: updated });
  } catch (err) {
    console.error('[admin/users/update]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/tutors/pending
router.get('/tutors/pending', requireAuth, requireAdmin, (req, res) => {
  try {
    const tutors = db.prepare(`
      SELECT tp.*, u.name, u.email, u.location, u.created_at as user_created
      FROM tutor_profiles tp
      JOIN users u ON u.id = tp.user_id
      WHERE tp.is_approved = 0
      ORDER BY tp.created_at ASC
    `).all();
    res.json({ tutors });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/tutors/:id/approve
router.patch('/tutors/:id/approve', requireAuth, requireAdmin, (req, res) => {
  try {
    const { approved } = req.body;
    db.prepare('UPDATE tutor_profiles SET is_approved = ? WHERE id = ?').run(approved ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/bookings
router.get('/bookings', requireAuth, requireAdmin, (req, res) => {
  try {
    const bookings = db.prepare(`
      SELECT b.*, tu.name AS tutor_name, su.name AS student_name
      FROM bookings b
      JOIN users tu ON tu.id = b.tutor_id
      JOIN users su ON su.id = b.student_id
      ORDER BY b.created_at DESC
      LIMIT 50
    `).all();
    res.json({ bookings });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
