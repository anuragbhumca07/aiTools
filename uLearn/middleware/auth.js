'use strict';

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.session && req.session.user) return next();   // email/password sessions store user object
  return res.status(401).json({ error: 'Authentication required' });
}

function requireTutor(req, res, next) {
  const user = req.user || req.session.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.role !== 'tutor' && user.role !== 'admin') {
    return res.status(403).json({ error: 'Tutor access required' });
  }
  return next();
}

function requireStudent(req, res, next) {
  const user = req.user || req.session.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.role !== 'student' && user.role !== 'admin') {
    return res.status(403).json({ error: 'Student access required' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  const user = req.user || req.session.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

function optionalAuth(req, res, next) {
  return next();
}

module.exports = { requireAuth, requireTutor, requireStudent, requireAdmin, optionalAuth };
