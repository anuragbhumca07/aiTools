'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'ulearn.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'student',
  phone TEXT,
  bio TEXT,
  location TEXT,
  timezone TEXT DEFAULT 'UTC',
  is_verified INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  last_seen INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tutor_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  headline TEXT,
  subjects TEXT NOT NULL DEFAULT '[]',
  levels TEXT DEFAULT '[]',
  teaching_mode TEXT DEFAULT 'both',
  hourly_rate REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  experience_years INTEGER DEFAULT 0,
  education TEXT DEFAULT '[]',
  certifications TEXT DEFAULT '[]',
  languages TEXT DEFAULT '["English"]',
  availability TEXT DEFAULT '{}',
  intro_video TEXT,
  response_time TEXT DEFAULT '< 1 hour',
  total_students INTEGER DEFAULT 0,
  total_sessions INTEGER DEFAULT 0,
  avg_rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  is_featured INTEGER DEFAULT 0,
  is_approved INTEGER DEFAULT 1,
  profile_views INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE VIRTUAL TABLE IF NOT EXISTS tutor_search USING fts5(
  tutor_id UNINDEXED,
  name,
  headline,
  subjects,
  bio,
  location
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutor_id INTEGER NOT NULL REFERENCES tutor_profiles(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  is_verified INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(tutor_id, student_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant1_id INTEGER NOT NULL REFERENCES users(id),
  participant2_id INTEGER NOT NULL REFERENCES users(id),
  last_message_at INTEGER DEFAULT (unixepoch()),
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(participant1_id, participant2_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutor_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  status TEXT DEFAULT 'pending',
  mode TEXT DEFAULT 'online',
  notes TEXT,
  price REAL,
  meeting_link TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tutor_id INTEGER NOT NULL REFERENCES tutor_profiles(id) ON DELETE CASCADE,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(student_id, tutor_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT,
  icon TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_tutor_rate ON tutor_profiles(hourly_rate);
CREATE INDEX IF NOT EXISTS idx_tutor_rating ON tutor_profiles(avg_rating DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_tutor ON bookings(tutor_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`);

// ---------------------------------------------------------------------------
// Migrations — safe column additions for existing databases
// ---------------------------------------------------------------------------
const addColSafe = (table, col, type) => {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); } catch (_) {}
};
addColSafe('users', 'email_verification_token', 'TEXT');
addColSafe('users', 'email_verification_expires', 'INTEGER');

// ---------------------------------------------------------------------------
// Seed Data
// ---------------------------------------------------------------------------
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) return; // Already seeded

  console.log('[db] Seeding database...');

  // Subjects
  const subjectData = [
    // Mathematics
    { name: 'Mathematics', category: 'Mathematics', icon: '∑' },
    { name: 'Calculus', category: 'Mathematics', icon: '∫' },
    { name: 'Algebra', category: 'Mathematics', icon: '𝑥' },
    { name: 'Geometry', category: 'Mathematics', icon: '△' },
    { name: 'Statistics', category: 'Mathematics', icon: '📊' },
    { name: 'Trigonometry', category: 'Mathematics', icon: '∠' },
    // Sciences
    { name: 'Physics', category: 'Science', icon: '⚛' },
    { name: 'Chemistry', category: 'Science', icon: '🧪' },
    { name: 'Biology', category: 'Science', icon: '🧬' },
    { name: 'Environmental Science', category: 'Science', icon: '🌍' },
    { name: 'Astronomy', category: 'Science', icon: '🔭' },
    // Languages
    { name: 'English', category: 'Languages', icon: '📝' },
    { name: 'Spanish', category: 'Languages', icon: '🇪🇸' },
    { name: 'French', category: 'Languages', icon: '🇫🇷' },
    { name: 'German', category: 'Languages', icon: '🇩🇪' },
    { name: 'Mandarin', category: 'Languages', icon: '🇨🇳' },
    { name: 'Japanese', category: 'Languages', icon: '🇯🇵' },
    { name: 'Arabic', category: 'Languages', icon: '🇸🇦' },
    { name: 'Italian', category: 'Languages', icon: '🇮🇹' },
    { name: 'Portuguese', category: 'Languages', icon: '🇧🇷' },
    // Programming
    { name: 'Python', category: 'Programming', icon: '🐍' },
    { name: 'JavaScript', category: 'Programming', icon: '⚡' },
    { name: 'Java', category: 'Programming', icon: '☕' },
    { name: 'C++', category: 'Programming', icon: '⚙' },
    { name: 'Web Development', category: 'Programming', icon: '🌐' },
    { name: 'Data Science', category: 'Programming', icon: '📈' },
    { name: 'Machine Learning', category: 'Programming', icon: '🤖' },
    { name: 'SQL', category: 'Programming', icon: '🗄' },
    // Music
    { name: 'Piano', category: 'Music', icon: '🎹' },
    { name: 'Guitar', category: 'Music', icon: '🎸' },
    { name: 'Violin', category: 'Music', icon: '🎻' },
    { name: 'Singing', category: 'Music', icon: '🎤' },
    { name: 'Drums', category: 'Music', icon: '🥁' },
    { name: 'Music Theory', category: 'Music', icon: '🎵' },
    // Humanities
    { name: 'History', category: 'Humanities', icon: '📜' },
    { name: 'Geography', category: 'Humanities', icon: '🗺' },
    { name: 'Philosophy', category: 'Humanities', icon: '🤔' },
    { name: 'Economics', category: 'Humanities', icon: '💹' },
    { name: 'Psychology', category: 'Humanities', icon: '🧠' },
    { name: 'Literature', category: 'Humanities', icon: '📚' },
    // Arts
    { name: 'Drawing', category: 'Arts', icon: '✏' },
    { name: 'Painting', category: 'Arts', icon: '🎨' },
    { name: 'Photography', category: 'Arts', icon: '📷' },
    { name: 'Graphic Design', category: 'Arts', icon: '🖌' },
    // Test Prep
    { name: 'SAT Prep', category: 'Test Prep', icon: '📋' },
    { name: 'ACT Prep', category: 'Test Prep', icon: '📋' },
    { name: 'GRE Prep', category: 'Test Prep', icon: '📋' },
    { name: 'IELTS', category: 'Test Prep', icon: '🗣' },
    { name: 'TOEFL', category: 'Test Prep', icon: '🗣' },
    // Business
    { name: 'Accounting', category: 'Business', icon: '💼' },
    { name: 'Finance', category: 'Business', icon: '💰' },
    { name: 'Marketing', category: 'Business', icon: '📣' },
  ];

  const insertSubject = db.prepare('INSERT OR IGNORE INTO subjects (name, category, icon) VALUES (?, ?, ?)');
  for (const s of subjectData) insertSubject.run(s.name, s.category, s.icon);

  // Demo users
  const insertUser = db.prepare(`INSERT INTO users (email, password_hash, name, avatar, role, bio, location, is_verified, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`);
  const insertTutor = db.prepare(`INSERT INTO tutor_profiles (user_id, headline, subjects, levels, teaching_mode, hourly_rate, currency, experience_years, education, certifications, languages, availability, response_time, total_students, total_sessions, avg_rating, review_count, is_featured, is_approved) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
  const insertSearch = db.prepare('INSERT INTO tutor_search (tutor_id, name, headline, subjects, bio, location) VALUES (?, ?, ?, ?, ?, ?)');
  const insertReview = db.prepare('INSERT OR IGNORE INTO reviews (tutor_id, student_id, rating, comment, is_verified) VALUES (?, ?, ?, ?, 1)');

  const adminHash = bcrypt.hashSync('Admin123!', 10);
  const tutorHash = bcrypt.hashSync('Tutor123!', 10);
  const studentHash = bcrypt.hashSync('Student123!', 10);

  // Admin
  insertUser.run('admin@ulearn.com', adminHash, 'Admin User', null, 'admin', 'Platform administrator', 'San Francisco, CA');

  // Tutors
  const tutor1Id = insertUser.run('tutor1@ulearn.com', tutorHash, 'Dr. Sarah Chen', null, 'tutor',
    'PhD in Mathematics from MIT. I make complex concepts simple and enjoyable. 12 years teaching experience from high school to university level. My students consistently score in the top 10% on standardized tests.',
    'New York, NY').lastInsertRowid;
  const tutor1ProfileId = insertTutor.run(tutor1Id,
    'PhD Mathematician · MIT Grad · Top-Rated Tutor',
    JSON.stringify(['Mathematics', 'Calculus', 'Algebra', 'Statistics', 'SAT Prep']),
    JSON.stringify(['Middle School', 'High School', 'College', 'Graduate']),
    'both', 85, 12,
    JSON.stringify([{ degree: 'PhD Mathematics', institution: 'MIT', year: 2010 }, { degree: 'BSc Mathematics', institution: 'Stanford University', year: 2006 }]),
    JSON.stringify(['Certified Math Teacher', 'SAT Prep Specialist']),
    JSON.stringify(['English', 'Mandarin']),
    JSON.stringify({ mon: [9,20], tue: [9,20], wed: [9,20], thu: [9,20], fri: [9,18], sat: [10,15] }),
    '< 1 hour', 248, 1340, 4.9, 127
  ).lastInsertRowid;
  insertSearch.run(tutor1ProfileId, 'Dr. Sarah Chen', 'PhD Mathematician · MIT Grad · Top-Rated Tutor',
    'Mathematics Calculus Algebra Statistics SAT Prep',
    'PhD in Mathematics from MIT. I make complex concepts simple and enjoyable.',
    'New York, NY');

  const tutor2Id = insertUser.run('tutor2@ulearn.com', tutorHash, 'James Rodriguez', null, 'tutor',
    'Former Google software engineer with 8 years of industry experience. I teach programming and computer science in a practical, project-based way. From beginner Python to advanced machine learning.',
    'San Francisco, CA').lastInsertRowid;
  const tutor2ProfileId = insertTutor.run(tutor2Id,
    'Ex-Google Engineer · Full-Stack & ML Specialist',
    JSON.stringify(['Python', 'JavaScript', 'Machine Learning', 'Data Science', 'Web Development']),
    JSON.stringify(['Beginner', 'Intermediate', 'Advanced', 'Professional']),
    'online', 95, 8,
    JSON.stringify([{ degree: 'MSc Computer Science', institution: 'UC Berkeley', year: 2014 }, { degree: 'BSc Software Engineering', institution: 'UCLA', year: 2012 }]),
    JSON.stringify(['Google Certified Professional', 'AWS Solutions Architect', 'TensorFlow Developer']),
    JSON.stringify(['English', 'Spanish']),
    JSON.stringify({ mon: [18,22], tue: [18,22], wed: [18,22], sat: [9,18], sun: [9,18] }),
    '< 2 hours', 312, 1870, 4.8, 203
  ).lastInsertRowid;
  insertSearch.run(tutor2ProfileId, 'James Rodriguez', 'Ex-Google Engineer · Full-Stack & ML Specialist',
    'Python JavaScript Machine Learning Data Science Web Development',
    'Former Google software engineer with 8 years of industry experience.',
    'San Francisco, CA');

  const tutor3Id = insertUser.run('tutor3@ulearn.com', tutorHash, 'Emma Larsson', null, 'tutor',
    'Native Swedish speaker with fluency in 5 European languages. Language learning specialist and certified IELTS examiner. My communicative approach gets students speaking confidently from day one.',
    'London, UK').lastInsertRowid;
  const tutor3ProfileId = insertTutor.run(tutor3Id,
    'Polyglot · Certified IELTS Examiner · 5 Languages',
    JSON.stringify(['English', 'French', 'German', 'Spanish', 'IELTS', 'TOEFL']),
    JSON.stringify(['Beginner', 'Intermediate', 'Advanced', 'Business']),
    'online', 65, 8,
    JSON.stringify([{ degree: 'MA Linguistics', institution: 'University of Stockholm', year: 2013 }, { degree: 'CELTA Certificate', institution: 'Cambridge', year: 2014 }]),
    JSON.stringify(['IELTS Examiner (British Council)', 'CELTA Certified', 'DELF Examiner']),
    JSON.stringify(['English', 'French', 'German', 'Spanish', 'Swedish']),
    JSON.stringify({ mon: [8,20], tue: [8,20], wed: [8,20], thu: [8,20], fri: [8,20] }),
    '< 30 min', 189, 2100, 4.9, 168
  ).lastInsertRowid;
  insertSearch.run(tutor3ProfileId, 'Emma Larsson', 'Polyglot · Certified IELTS Examiner · 5 Languages',
    'English French German Spanish IELTS TOEFL',
    'Native Swedish speaker with fluency in 5 European languages.',
    'London, UK');

  const tutor4Id = insertUser.run('tutor4@ulearn.com', tutorHash, 'Dr. Aisha Patel', null, 'tutor',
    'Medical doctor turned science educator. I specialize in making biology and chemistry accessible and memorable using visual learning techniques. Helping pre-med and A-Level students excel.',
    'Chicago, IL').lastInsertRowid;
  const tutor4ProfileId = insertTutor.run(tutor4Id,
    'MD-Educator · Biology & Chemistry · Pre-Med Specialist',
    JSON.stringify(['Biology', 'Chemistry', 'Physics', 'Environmental Science']),
    JSON.stringify(['Middle School', 'High School', 'A-Level', 'College', 'Pre-Med']),
    'both', 75, 10,
    JSON.stringify([{ degree: 'Doctor of Medicine (MD)', institution: 'Johns Hopkins', year: 2011 }, { degree: 'BSc Biochemistry', institution: 'Princeton', year: 2007 }]),
    JSON.stringify(['Board Certified Physician', 'AP Biology Specialist']),
    JSON.stringify(['English', 'Hindi', 'Gujarati']),
    JSON.stringify({ mon: [9,17], wed: [9,17], fri: [9,17], sat: [9,14] }),
    '< 1 hour', 156, 890, 4.7, 94
  ).lastInsertRowid;
  insertSearch.run(tutor4ProfileId, 'Dr. Aisha Patel', 'MD-Educator · Biology & Chemistry · Pre-Med Specialist',
    'Biology Chemistry Physics Environmental Science',
    'Medical doctor turned science educator.',
    'Chicago, IL');

  const tutor5Id = insertUser.run('tutor5@ulearn.com', tutorHash, 'Marcus Thompson', null, 'tutor',
    'Professional jazz musician and Berklee graduate. I teach piano, guitar, and music theory from beginners to advanced performers. My lessons blend classical technique with modern music styles.',
    'Nashville, TN').lastInsertRowid;
  const tutor5ProfileId = insertTutor.run(tutor5Id,
    'Berklee Grad · Jazz Pianist · Piano & Guitar',
    JSON.stringify(['Piano', 'Guitar', 'Music Theory', 'Singing']),
    JSON.stringify(['Beginner', 'Intermediate', 'Advanced', 'Performance']),
    'both', 55, 15,
    JSON.stringify([{ degree: 'BM Jazz Composition', institution: 'Berklee College of Music', year: 2008 }]),
    JSON.stringify(['ABRSM Grade 8 Piano', 'RGT Guitar Diploma']),
    JSON.stringify(['English']),
    JSON.stringify({ mon: [10,20], tue: [10,20], wed: [10,20], thu: [10,20], fri: [10,20], sat: [10,18], sun: [12,18] }),
    '< 3 hours', 134, 1200, 4.8, 87
  ).lastInsertRowid;
  insertSearch.run(tutor5ProfileId, 'Marcus Thompson', 'Berklee Grad · Jazz Pianist · Piano & Guitar',
    'Piano Guitar Music Theory Singing',
    'Professional jazz musician and Berklee graduate.',
    'Nashville, TN');

  // Students
  const student1Id = insertUser.run('student1@ulearn.com', studentHash, 'Alex Johnson', null, 'student',
    'High school junior looking for help with AP Calculus and SAT prep', 'Boston, MA').lastInsertRowid;
  insertUser.run('student2@ulearn.com', studentHash, 'Maria Santos', null, 'student',
    'College student studying CS, need Python and ML help', 'Austin, TX');

  // Reviews
  insertReview.run(tutor1ProfileId, student1Id, 5, 'Dr. Chen is absolutely incredible! She explained derivatives in a way that finally made sense. My grade went from a C to an A in just 6 weeks.');
  insertReview.run(tutor2ProfileId, student1Id, 5, 'James is a fantastic teacher. His real-world experience at Google means the lessons are practical and directly applicable. Built my first full-stack app after just 4 sessions!');
  insertReview.run(tutor3ProfileId, student1Id, 5, 'Emma\'s approach to language learning is unlike anything I\'ve experienced. I can already hold basic conversations in French after just 2 months!');
  insertReview.run(tutor4ProfileId, student1Id, 4, 'Dr. Patel brings such enthusiasm to science. Her medical background gives her incredible real-world examples. Highly recommend for pre-med students.');
  insertReview.run(tutor5ProfileId, student1Id, 5, 'Marcus is a gifted teacher. He\'s patient, knowledgeable, and makes every lesson fun. My piano skills have improved dramatically.');

  // Sample notifications
  const insertNotif = db.prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)');
  insertNotif.run(tutor1Id, 'review', 'New Review Received', 'Alex Johnson left you a 5-star review!', '/tutor-profile.html?id=' + tutor1ProfileId);
  insertNotif.run(student1Id, 'booking', 'Booking Confirmed', 'Your session with Dr. Sarah Chen is confirmed', '/dashboard-student.html');

  console.log('[db] Seed complete — 5 tutors, 2 students, 1 admin created');
}

try {
  seed();
} catch (err) {
  console.error('[db] Seed error:', err.message);
}

module.exports = db;
