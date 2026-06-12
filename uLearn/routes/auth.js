'use strict';

const express = require('express');
const router  = express.Router();
const passport = require('passport');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');
const { sendWelcomeStudent, sendWelcomeTutor, sendVerificationEmail } = require('../utils/email');

// ── Helpers ───────────────────────────────────────────────────────

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name,
    avatar: u.avatar, role: u.role,
    is_verified: u.is_verified,
  };
}

function freshUser(id) {
  return db.prepare(`
    SELECT id, email, name, avatar, role, bio, location, phone, timezone, is_verified
    FROM users WHERE id = ?
  `).get(id);
}

function generateVerifyToken(userId) {
  const token   = uuidv4();
  const expires = Math.floor(Date.now() / 1000) + 86400; // 24h
  db.prepare('UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?')
    .run(token, expires, userId);
  return token;
}

// ── GET /auth/me ──────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const u = req.user || req.session?.user;
  if (!u) return res.json({ user: null });
  const fresh = freshUser(u.id);
  if (!fresh) return res.json({ user: null });
  res.json({ user: fresh });
});

// ── POST /auth/signup ─────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const userRole = ['student', 'tutor'].includes(role) ? role : 'student';
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash   = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      `INSERT INTO users (email, password_hash, name, role, is_verified) VALUES (?, ?, ?, ?, 0)`
    ).run(email.toLowerCase(), hash, name, userRole);
    const userId = result.lastInsertRowid;

    if (userRole === 'tutor') {
      db.prepare(`INSERT INTO tutor_profiles (user_id, subjects, is_approved) VALUES (?, '[]', 1)`).run(userId);
    }

    // Generate verification token & send email (non-blocking)
    const token = generateVerifyToken(userId);
    if (userRole === 'tutor') {
      sendWelcomeTutor(email, name, [], 0, token).catch(e => console.error('[email]', e.message));
    } else {
      sendWelcomeStudent(email, name, token).catch(e => console.error('[email]', e.message));
    }

    const user = freshUser(userId);
    req.session.user = publicUser(user);
    if (req.login) req.login(user, err => { if (err) console.error('login err', err); });

    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('[auth/signup]', err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid email or password' });
    req.login(user, err2 => {
      if (err2) return next(err2);
      req.session.user = publicUser(user);
      res.json({ user: publicUser(user) });
    });
  })(req, res, next);
});

// ── POST /auth/logout ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// ── GET /auth/verify-email/:token  (path-based, avoids QP encoding issues)
router.get('/verify-email/:token', (req, res) => {
  req.query.token = req.params.token;
  return verifyEmailHandler(req, res);
});

// ── GET /auth/verify-email?token=xxx ─────────────────────────────
router.get('/verify-email', (req, res) => verifyEmailHandler(req, res));

function verifyEmailHandler(req, res) {
  const { token } = req.query;
  if (!token) return res.redirect('/login.html?error=invalid_token');

  const now  = Math.floor(Date.now() / 1000);
  const user = db.prepare(`
    SELECT id, name, role FROM users
    WHERE email_verification_token = ? AND email_verification_expires > ?
  `).get(token, now);

  if (!user) {
    return res.redirect('/login.html?error=expired_token');
  }

  db.prepare(`
    UPDATE users SET is_verified = 1, email_verification_token = NULL, email_verification_expires = NULL
    WHERE id = ?
  `).run(user.id);

  // Update session if the same user is logged in
  if (req.session?.user?.id === user.id) {
    req.session.user.is_verified = 1;
  }

  return res.redirect('/login.html?verified=1');
}

// ── POST /auth/resend-verification ───────────────────────────────
router.post('/resend-verification', async (req, res) => {
  const u = req.user || req.session?.user;
  if (!u) return res.status(401).json({ error: 'Not logged in' });

  const fresh = freshUser(u.id);
  if (!fresh) return res.status(404).json({ error: 'User not found' });
  if (fresh.is_verified) return res.json({ ok: true, message: 'Already verified' });

  const token = generateVerifyToken(fresh.id);
  try {
    await sendVerificationEmail(fresh.email, fresh.name, token);
    res.json({ ok: true, message: 'Verification email sent' });
  } catch (e) {
    console.error('[resend-verify]', e.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ── GET /auth/google ──────────────────────────────────────────────
router.get('/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return res.status(503).json({ error: 'Google OAuth not configured' });
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// ── GET /auth/google/callback ─────────────────────────────────────
router.get('/google/callback', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return res.redirect('/login.html?error=google_not_configured');

  passport.authenticate('google', { failureRedirect: '/login.html?error=google_failed' }, (err, user) => {
    if (err || !user) return res.redirect('/login.html?error=google_failed');
    req.login(user, err2 => {
      if (err2) return res.redirect('/login.html?error=server_error');
      req.session.user = publicUser(user);

      // Google users are considered pre-verified; send welcome if first login
      const fresh = freshUser(user.id);
      if (fresh && !fresh.is_verified) {
        db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(user.id);
        req.session.user.is_verified = 1;
        if (user.role === 'tutor') {
          sendWelcomeTutor(user.email, user.name, [], 0, 'google-verified').catch(() => {});
        } else {
          sendWelcomeStudent(user.email, user.name, 'google-verified').catch(() => {});
        }
      }

      if (user.role === 'tutor')  return res.redirect('/dashboard-tutor.html');
      if (user.role === 'admin')  return res.redirect('/admin.html');
      return res.redirect('/dashboard-student.html');
    });
  })(req, res, next);
});

module.exports = router;
