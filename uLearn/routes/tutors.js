'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireTutor } = require('../middleware/auth');
const { sendWelcomeTutor } = require('../utils/email');

// Helper to get full tutor object
function getTutorById(id) {
  return db.prepare(`
    SELECT tp.*, u.name, u.email, u.avatar, u.bio, u.location, u.phone, u.timezone, u.is_verified, u.last_seen
    FROM tutor_profiles tp
    JOIN users u ON u.id = tp.user_id
    WHERE tp.id = ?
  `).get(id);
}

// GET /api/tutors/featured
router.get('/featured', (req, res) => {
  try {
    const tutors = db.prepare(`
      SELECT tp.*, u.name, u.email, u.avatar, u.bio, u.location, u.is_verified
      FROM tutor_profiles tp
      JOIN users u ON u.id = tp.user_id
      WHERE tp.is_featured = 1 AND tp.is_approved = 1 AND u.is_active = 1
      ORDER BY tp.avg_rating DESC, tp.review_count DESC
      LIMIT 8
    `).all();
    res.json({ tutors });
  } catch (err) {
    console.error('[tutors/featured]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tutors — search with filters
router.get('/', (req, res) => {
  try {
    const {
      q = '', subject = '', min_rate = 0, max_rate = 9999,
      rating = 0, mode = '', page = 1, limit = 12, sort = 'rating'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let conditions = ['tp.is_approved = 1', 'u.is_active = 1'];
    let params = [];

    if (q && q.trim()) {
      // FTS5 search
      const ftsIds = db.prepare(`
        SELECT CAST(tutor_id AS INTEGER) as tid FROM tutor_search WHERE tutor_search MATCH ?
      `).all(q.trim() + '*').map(r => r.tid);
      if (ftsIds.length === 0) {
        return res.json({ tutors: [], total: 0, page: pageNum, pages: 0 });
      }
      conditions.push(`tp.id IN (${ftsIds.join(',')})`);
    }

    if (subject) {
      conditions.push(`tp.subjects LIKE ?`);
      params.push(`%${subject}%`);
    }

    if (parseFloat(min_rate) > 0) {
      conditions.push(`tp.hourly_rate >= ?`);
      params.push(parseFloat(min_rate));
    }

    if (parseFloat(max_rate) < 9999) {
      conditions.push(`tp.hourly_rate <= ?`);
      params.push(parseFloat(max_rate));
    }

    if (parseFloat(rating) > 0) {
      conditions.push(`tp.avg_rating >= ?`);
      params.push(parseFloat(rating));
    }

    if (mode && ['online', 'in-person', 'both'].includes(mode)) {
      conditions.push(`(tp.teaching_mode = ? OR tp.teaching_mode = 'both')`);
      params.push(mode);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const sortMap = {
      rating: 'tp.avg_rating DESC, tp.review_count DESC',
      price_asc: 'tp.hourly_rate ASC',
      price_desc: 'tp.hourly_rate DESC',
      newest: 'tp.created_at DESC',
      sessions: 'tp.total_sessions DESC',
    };
    const orderBy = sortMap[sort] || sortMap.rating;

    const countSql = `SELECT COUNT(*) as total FROM tutor_profiles tp JOIN users u ON u.id = tp.user_id ${where}`;
    const { total } = db.prepare(countSql).get(...params);

    const sql = `
      SELECT tp.id, tp.user_id, tp.headline, tp.subjects, tp.levels, tp.teaching_mode,
             tp.hourly_rate, tp.currency, tp.experience_years, tp.avg_rating, tp.review_count,
             tp.total_students, tp.total_sessions, tp.is_featured, tp.response_time,
             u.name, u.avatar, u.location, u.is_verified
      FROM tutor_profiles tp
      JOIN users u ON u.id = tp.user_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const tutors = db.prepare(sql).all(...params);

    // Increment profile views for first page results
    if (pageNum === 1 && tutors.length > 0) {
      const ids = tutors.map(t => t.id).join(',');
      db.prepare(`UPDATE tutor_profiles SET profile_views = profile_views + 1 WHERE id IN (${ids})`).run();
    }

    res.json({
      tutors,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum)
    });
  } catch (err) {
    console.error('[tutors/search]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tutors/:id — full profile
router.get('/:id', (req, res) => {
  try {
    const tutor = getTutorById(req.params.id);
    if (!tutor) return res.status(404).json({ error: 'Tutor not found' });
    // Increment views
    db.prepare('UPDATE tutor_profiles SET profile_views = profile_views + 1 WHERE id = ?').run(tutor.id);
    res.json({ tutor });
  } catch (err) {
    console.error('[tutors/:id]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tutors/profile — create/update tutor profile
// requireTutor removed: user signs up as 'tutor' and immediately posts profile in same flow
router.post('/profile', requireAuth, (req, res) => {
  // Ensure caller has tutor role (covers both existing tutors and newly-signed-up ones)
  const caller = req.user || req.session?.user;
  if (caller && caller.role !== 'tutor' && caller.role !== 'admin') {
    return res.status(403).json({ error: 'Tutor access required' });
  }
  try {
    const user = req.user || req.session.user;
    const {
      headline, subjects, levels, teaching_mode, hourly_rate,
      experience_years, education, certifications, languages,
      availability, intro_video, response_time
    } = req.body;

    const existing = db.prepare('SELECT id FROM tutor_profiles WHERE user_id = ?').get(user.id);

    if (existing) {
      db.prepare(`
        UPDATE tutor_profiles SET
          headline = ?, subjects = ?, levels = ?, teaching_mode = ?,
          hourly_rate = ?, experience_years = ?, education = ?,
          certifications = ?, languages = ?, availability = ?,
          intro_video = ?, response_time = ?, updated_at = unixepoch()
        WHERE user_id = ?
      `).run(
        headline, JSON.stringify(subjects || []), JSON.stringify(levels || []),
        teaching_mode || 'both', parseFloat(hourly_rate) || 0, parseInt(experience_years) || 0,
        JSON.stringify(education || []), JSON.stringify(certifications || []),
        JSON.stringify(languages || ['English']), JSON.stringify(availability || {}),
        intro_video, response_time || '< 1 hour', user.id
      );

      // Update FTS
      const profile = db.prepare('SELECT id FROM tutor_profiles WHERE user_id = ?').get(user.id);
      const u = db.prepare('SELECT name, bio, location FROM users WHERE id = ?').get(user.id);
      db.prepare('DELETE FROM tutor_search WHERE tutor_id = ?').run(profile.id);
      db.prepare('INSERT INTO tutor_search (tutor_id, name, headline, subjects, bio, location) VALUES (?, ?, ?, ?, ?, ?)')
        .run(profile.id, u.name, headline, Array.isArray(subjects) ? subjects.join(' ') : subjects, u.bio, u.location);

      const updated = getTutorById(existing.id);
      return res.json({ tutor: updated });
    } else {
      const result = db.prepare(`
        INSERT INTO tutor_profiles (user_id, headline, subjects, levels, teaching_mode, hourly_rate, experience_years, education, certifications, languages, availability, intro_video, response_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id, headline, JSON.stringify(subjects || []), JSON.stringify(levels || []),
        teaching_mode || 'both', parseFloat(hourly_rate) || 0, parseInt(experience_years) || 0,
        JSON.stringify(education || []), JSON.stringify(certifications || []),
        JSON.stringify(languages || ['English']), JSON.stringify(availability || {}),
        intro_video, response_time || '< 1 hour'
      );

      const u = db.prepare('SELECT name, bio, location FROM users WHERE id = ?').get(user.id);
      db.prepare('INSERT INTO tutor_search (tutor_id, name, headline, subjects, bio, location) VALUES (?, ?, ?, ?, ?, ?)')
        .run(result.lastInsertRowid, u.name, headline, Array.isArray(subjects) ? subjects.join(' ') : subjects, u.bio, u.location);

      const created = getTutorById(result.lastInsertRowid);

      // Send welcome email with actual profile details (non-blocking)
      const uFull = db.prepare('SELECT email, name FROM users WHERE id = ?').get(user.id);
      const verTok = db.prepare('SELECT email_verification_token FROM users WHERE id = ?').get(user.id);
      if (uFull && verTok?.email_verification_token) {
        sendWelcomeTutor(uFull.email, uFull.name, subjects, hourly_rate, verTok.email_verification_token)
          .catch(e => console.error('[email-tutor]', e.message));
      }

      return res.status(201).json({ tutor: created });
    }
  } catch (err) {
    console.error('[tutors/profile]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tutors/:id/view
router.post('/:id/view', (req, res) => {
  try {
    db.prepare('UPDATE tutor_profiles SET profile_views = profile_views + 1 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tutors/:id/bookmark
router.post('/:id/bookmark', requireAuth, (req, res) => {
  try {
    const user = req.user || req.session.user;
    const tutorId = req.params.id;
    const existing = db.prepare('SELECT id FROM bookmarks WHERE student_id = ? AND tutor_id = ?').get(user.id, tutorId);
    if (existing) {
      db.prepare('DELETE FROM bookmarks WHERE student_id = ? AND tutor_id = ?').run(user.id, tutorId);
      return res.json({ bookmarked: false });
    } else {
      db.prepare('INSERT INTO bookmarks (student_id, tutor_id) VALUES (?, ?)').run(user.id, tutorId);
      return res.json({ bookmarked: true });
    }
  } catch (err) {
    console.error('[tutors/bookmark]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tutors/subjects/list
router.get('/subjects/list', (req, res) => {
  try {
    const subjects = db.prepare('SELECT * FROM subjects ORDER BY category, name').all();
    res.json({ subjects });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
