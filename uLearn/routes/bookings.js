'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// POST /api/bookings
router.post('/', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { tutor_id, subject, scheduled_at, duration_minutes, mode, notes, price } = req.body;

    if (!tutor_id || !subject || !scheduled_at) {
      return res.status(400).json({ error: 'tutor_id, subject, and scheduled_at are required' });
    }

    // Get tutor's user_id from profile id
    const tutorProfile = db.prepare('SELECT user_id, hourly_rate FROM tutor_profiles WHERE id = ?').get(tutor_id);
    if (!tutorProfile) return res.status(404).json({ error: 'Tutor not found' });

    const finalPrice = price || (tutorProfile.hourly_rate * ((parseInt(duration_minutes) || 60) / 60));

    const result = db.prepare(`
      INSERT INTO bookings (tutor_id, student_id, subject, scheduled_at, duration_minutes, mode, notes, price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tutorProfile.user_id, user.id, subject, parseInt(scheduled_at), parseInt(duration_minutes) || 60, mode || 'online', notes, finalPrice);

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

    // Notify tutor
    const tutorUser = db.prepare('SELECT id, name FROM users WHERE id = ?').get(tutorProfile.user_id);
    db.prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)').run(
      tutorProfile.user_id, 'booking',
      'New Booking Request',
      `${user.name} wants to book a ${subject} session`,
      '/dashboard-tutor.html'
    );

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${tutorProfile.user_id}`).emit('new_booking', booking);
    }

    res.status(201).json({ booking });
  } catch (err) {
    console.error('[bookings/create]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/bookings — my bookings
router.get('/', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { status, upcoming } = req.query;

    let where = `(b.tutor_id = ? OR b.student_id = ?)`;
    const params = [user.id, user.id];

    if (status) {
      where += ` AND b.status = ?`;
      params.push(status);
    }

    if (upcoming === '1') {
      where += ` AND b.scheduled_at > ? AND b.status IN ('pending','confirmed')`;
      params.push(Math.floor(Date.now() / 1000));
    }

    const bookings = db.prepare(`
      SELECT b.*,
        tu.name AS tutor_name, tu.avatar AS tutor_avatar,
        su.name AS student_name, su.avatar AS student_avatar,
        tp.id AS tutor_profile_id
      FROM bookings b
      JOIN users tu ON tu.id = b.tutor_id
      JOIN users su ON su.id = b.student_id
      LEFT JOIN tutor_profiles tp ON tp.user_id = b.tutor_id
      WHERE ${where}
      ORDER BY b.scheduled_at ASC
    `).all(...params);

    res.json({ bookings });
  } catch (err) {
    console.error('[bookings/list]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/bookings/:id
router.patch('/:id', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const { status, meeting_link } = req.body;

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Verify ownership
    if (booking.tutor_id !== user.id && booking.student_id !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allowed = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    db.prepare('UPDATE bookings SET status = COALESCE(?, status), meeting_link = COALESCE(?, meeting_link) WHERE id = ?')
      .run(status, meeting_link, req.params.id);

    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

    // Notify the other party
    const notifyId = booking.tutor_id === user.id ? booking.student_id : booking.tutor_id;
    const statusMsg = { confirmed: 'confirmed', cancelled: 'cancelled', completed: 'marked as complete' };
    if (status && statusMsg[status]) {
      db.prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)').run(
        notifyId, 'booking', `Booking ${status}`,
        `Your ${booking.subject} session has been ${statusMsg[status]}`, '/dashboard-student.html'
      );
    }

    res.json({ booking: updated });
  } catch (err) {
    console.error('[bookings/update]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
