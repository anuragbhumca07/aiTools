'use strict';

// Scalability notes:
// - DB designed for PostgreSQL migration (no SQLite-specific types used in queries)
// - Session store can be swapped for Redis (connect-redis)
// - Socket.io can use Redis adapter for multi-server deployments
// - File uploads can be swapped for S3 (multer-s3)
// - Rate limiting can be swapped for Redis-backed rate limiter

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const multer = require('multer');
const SQLiteStore = require('connect-sqlite3')(session);

const db = require('./db');

const PORT = process.env.PORT || 3020;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.set('io', io);
// Trust Railway / any reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session (SQLite store — survives restarts)
const DATA_DIR = path.join(__dirname, 'data');
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'ulearn-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ---------------------------------------------------------------------------
// Passport Setup
// ---------------------------------------------------------------------------
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT id, email, name, avatar, role, bio, location, is_verified, is_active FROM users WHERE id = ?').get(id);
    if (!user || !user.is_active) return done(null, false);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// Local strategy
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return done(null, false, { message: 'No account found with that email' });
    if (!user.password_hash) return done(null, false, { message: 'Please use Google login for this account' });
    if (!user.is_active) return done(null, false, { message: 'Account has been deactivated' });
    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return done(null, false, { message: 'Incorrect password' });
    // Update last_seen
    db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(user.id);
    return done(null, { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role });
  } catch (err) {
    return done(err);
  }
}));

// Google OAuth (optional)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`
  }, (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      const name = profile.displayName;
      const avatar = profile.photos?.[0]?.value;
      const googleId = profile.id;

      let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
      if (user) {
        db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(user.id);
        return done(null, { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role });
      }

      // Check by email
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        db.prepare('UPDATE users SET google_id = ?, avatar = COALESCE(avatar, ?), last_seen = unixepoch() WHERE id = ?').run(googleId, avatar, user.id);
        return done(null, { id: user.id, email: user.email, name: user.name, avatar: user.avatar || avatar, role: user.role });
      }

      // New user
      const result = db.prepare('INSERT INTO users (email, google_id, name, avatar, role) VALUES (?, ?, ?, ?, ?)').run(email, googleId, name, avatar, 'student');
      const newUser = { id: result.lastInsertRowid, email, name, avatar, role: 'student' };
      return done(null, newUser);
    } catch (err) {
      return done(err);
    }
  }));
  console.log('[server] Google OAuth enabled');
} else {
  console.log('[server] Google OAuth not configured — email/password only');
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please try again later' },
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
});

app.use('/api/', apiLimiter);
app.use('/auth/login', authLimiter);
app.use('/auth/signup', authLimiter);

// ---------------------------------------------------------------------------
// File Uploads
// ---------------------------------------------------------------------------
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'avatars');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const user = req.user || req.session?.user;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `avatar-${user?.id || 'unknown'}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Avatar upload endpoint
app.post('/api/upload/avatar', (req, res, next) => {
  const user = req.user || req.session?.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  next();
}, upload.single('avatar'), (req, res) => {
  try {
    const user = req.user || req.session.user;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, user.id);
    if (req.session.user) req.session.user.avatar = avatarUrl;
    res.json({ avatar: avatarUrl });
  } catch (err) {
    console.error('[upload/avatar]', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ---------------------------------------------------------------------------
// Static Files
// ---------------------------------------------------------------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'web')));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/auth', require('./routes/auth'));
app.use('/api/tutors', require('./routes/tutors'));
app.use('/api/students', require('./routes/students'));
app.use('/api', require('./routes/messages'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

// Subjects
app.get('/api/subjects', (req, res) => {
  try {
    const subjects = db.prepare('SELECT * FROM subjects ORDER BY category, name').all();
    res.json({ subjects });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ulearn', port: PORT, timestamp: new Date().toISOString() });
});

// Serve HTML pages for SPA-like routing
const pages = ['index', 'search', 'tutor-profile', 'dashboard-tutor', 'dashboard-student', 'messages', 'login', 'admin', 'become-tutor'];
pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'web', `${page}.html`));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// ---------------------------------------------------------------------------
// Socket.io — Real-time Chat
// ---------------------------------------------------------------------------
const connectedUsers = new Map(); // userId -> Set of socketIds

io.use((socket, next) => {
  // Auth via session
  const session_ = socket.request.session;
  if (session_?.user?.id) {
    socket.userId = session_.user.id;
    return next();
  }
  // Allow unauthenticated for now (will just not join user room)
  next();
});

io.on('connection', (socket) => {
  if (socket.userId) {
    socket.join(`user:${socket.userId}`);
    if (!connectedUsers.has(socket.userId)) connectedUsers.set(socket.userId, new Set());
    connectedUsers.get(socket.userId).add(socket.id);
    // Broadcast online status
    socket.broadcast.emit('user_online', { userId: socket.userId });
  }

  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv:${conversationId}`);
  });

  socket.on('leave_conversation', (conversationId) => {
    socket.leave(`conv:${conversationId}`);
  });

  socket.on('typing', (data) => {
    if (socket.userId && data.conversationId) {
      socket.to(`conv:${data.conversationId}`).emit('typing', { userId: socket.userId, typing: data.typing });
    }
  });

  socket.on('send_message', (data) => {
    // Messages are saved via HTTP POST /api/messages and then emitted
    // This event is for real-time relay only
    if (!socket.userId) return;
    const { conversation_id, content } = data;
    if (!conversation_id || !content?.trim()) return;

    try {
      const convo = db.prepare('SELECT * FROM conversations WHERE id = ? AND (participant1_id = ? OR participant2_id = ?)').get(conversation_id, socket.userId, socket.userId);
      if (!convo) return;

      const result = db.prepare('INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)').run(conversation_id, socket.userId, content.trim());
      db.prepare('UPDATE conversations SET last_message_at = unixepoch() WHERE id = ?').run(conversation_id);

      const message = db.prepare('SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(result.lastInsertRowid);

      const recipientId = convo.participant1_id === socket.userId ? convo.participant2_id : convo.participant1_id;
      io.to(`user:${recipientId}`).emit('new_message', message);
      io.to(`user:${socket.userId}`).emit('message_sent', message);
      io.to(`conv:${conversation_id}`).emit('new_message', message);
    } catch (err) {
      console.error('[socket/send_message]', err);
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      const sockets = connectedUsers.get(socket.userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          connectedUsers.delete(socket.userId);
          socket.broadcast.emit('user_offline', { userId: socket.userId });
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Error Handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 5MB)' });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// 404 for API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`\n🎓 uLearn server running at http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Admin: admin@ulearn.com / Admin123!`);
  console.log(`   Tutor: tutor1@ulearn.com / Tutor123!`);
  console.log(`   Student: student1@ulearn.com / Student123!\n`);
});

module.exports = { app, server, io };
