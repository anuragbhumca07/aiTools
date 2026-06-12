'use strict';

// Email sending: Resend (HTTP, production) → SMTP (nodemailer) → Ethereal (dev)

const nodemailer = require('nodemailer');

let transporter = null;
let testAccount = null;
let resendClient = null;

function getResendClient() {
  if (resendClient) return resendClient;
  const { Resend } = require('resend');
  resendClient = new Resend(process.env.RESEND_API_KEY);
  console.log('[email] Using Resend HTTP API');
  return resendClient;
}

async function getTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 8000,
      socketTimeout: 8000,
      greetingTimeout: 8000,
    });
    console.log('[email] Using SMTP transport:', process.env.SMTP_HOST);
  } else {
    testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log('[email] No email provider configured — using Ethereal test account');
    console.log('[email] Ethereal inbox:', `https://ethereal.email/messages`);
    console.log('[email] Credentials:', testAccount.user, '/', testAccount.pass);
  }

  return transporter;
}

// RESEND_FROM: set to a verified Resend domain address, or leave unset to use test domain
const FROM_RESEND = process.env.RESEND_FROM || 'uLearn <onboarding@resend.dev>';
const FROM_SMTP   = process.env.SMTP_FROM   || '"uLearn" <noreply@ulearn.com>';
const BASE = process.env.BASE_URL || 'http://localhost:3020';

// ── Send helper ───────────────────────────────────────────────────

async function sendMail({ to, subject, html, text }) {
  if (process.env.RESEND_API_KEY) {
    const client = getResendClient();
    const { data, error } = await client.emails.send({
      from: FROM_RESEND,
      to: [to],
      subject,
      html,
      text,
    });
    if (error) throw new Error(`Resend error: ${error.message}`);
    return { messageId: data?.id, provider: 'resend' };
  }

  const t = await getTransporter();
  const info = await t.sendMail({ from: FROM_SMTP, to, subject, html, text });
  if (testAccount) {
    console.log(`[email → ${to}] Preview: ${nodemailer.getTestMessageUrl(info)}`);
  }
  return { messageId: info.messageId, provider: testAccount ? 'ethereal' : 'smtp' };
}

// ── Email templates ───────────────────────────────────────────────

function welcomeStudentHtml(name, verifyUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:'Segoe UI',Arial,sans-serif;background:#080b14;color:#e8edf5;margin:0;padding:0}
    .wrap{max-width:560px;margin:40px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid #1e2d45}
    .header{background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:40px 32px;text-align:center}
    .header h1{margin:0;font-size:28px;color:#fff;letter-spacing:-0.5px}
    .header p{margin:8px 0 0;color:rgba(255,255,255,.8);font-size:14px}
    .body{padding:32px}
    .body p{margin:0 0 16px;line-height:1.65;color:#c8d4e8;font-size:15px}
    .btn{display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;margin:8px 0}
    .info-box{background:#1a2234;border:1px solid #1e2d45;border-radius:10px;padding:20px;margin:20px 0}
    .info-box p{margin:0;font-size:13px;color:#7890a8}
    .footer{padding:20px 32px;text-align:center;border-top:1px solid #1e2d45}
    .footer p{margin:0;font-size:12px;color:#445566}
  </style></head><body>
  <div class="wrap">
    <div class="header">
      <h1>🎓 Welcome to uLearn!</h1>
      <p>Your learning journey starts now</p>
    </div>
    <div class="body">
      <p>Hi <strong>${name}</strong>,</p>
      <p>We're thrilled to have you join uLearn — the platform that connects students with world-class tutors across every subject.</p>
      <p>To unlock all features, please verify your email address:</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${verifyUrl}" class="btn">✅ Verify My Email</a>
      </div>
      <div class="info-box">
        <p>This link expires in <strong>24 hours</strong>. If you didn't create an account, you can safely ignore this email.</p>
      </div>
      <p>Once verified, you'll be able to:</p>
      <p>• 🔍 Search and connect with top tutors<br>• 💬 Message tutors directly<br>• 📅 Book 1-on-1 sessions<br>• ⭐ Leave reviews after sessions</p>
    </div>
    <div class="footer"><p>© ${new Date().getFullYear()} uLearn. All rights reserved.</p></div>
  </div></body></html>`;
}

function welcomeTutorHtml(name, subjects, hourlyRate, verifyUrl) {
  const subjectList = Array.isArray(subjects) ? subjects.join(', ') : subjects;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:'Segoe UI',Arial,sans-serif;background:#080b14;color:#e8edf5;margin:0;padding:0}
    .wrap{max-width:560px;margin:40px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid #1e2d45}
    .header{background:linear-gradient(135deg,#8b5cf6,#14b8a6);padding:40px 32px;text-align:center}
    .header h1{margin:0;font-size:28px;color:#fff;letter-spacing:-0.5px}
    .header p{margin:8px 0 0;color:rgba(255,255,255,.8);font-size:14px}
    .body{padding:32px}
    .body p{margin:0 0 16px;line-height:1.65;color:#c8d4e8;font-size:15px}
    .btn{display:inline-block;background:linear-gradient(135deg,#8b5cf6,#14b8a6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;margin:8px 0}
    .profile-card{background:#1a2234;border:1px solid #1e2d45;border-radius:10px;padding:20px;margin:20px 0}
    .profile-card .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1e2d45;font-size:14px}
    .profile-card .row:last-child{border:none}
    .profile-card .label{color:#7890a8}
    .profile-card .value{color:#e8edf5;font-weight:500}
    .warning{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:16px;margin:20px 0;font-size:13px;color:#f59e0b}
    .footer{padding:20px 32px;text-align:center;border-top:1px solid #1e2d45}
    .footer p{margin:0;font-size:12px;color:#445566}
  </style></head><body>
  <div class="wrap">
    <div class="header">
      <h1>🏆 Welcome, Tutor!</h1>
      <p>Your profile is live on uLearn</p>
    </div>
    <div class="body">
      <p>Hi <strong>${name}</strong>,</p>
      <p>Congratulations on joining uLearn as a tutor! Your profile has been created and is visible to students.</p>
      <div class="profile-card">
        <div class="row"><span class="label">Name</span><span class="value">${name}</span></div>
        <div class="row"><span class="label">Subjects</span><span class="value">${subjectList || 'Not specified'}</span></div>
        <div class="row"><span class="label">Hourly Rate</span><span class="value">$${parseFloat(hourlyRate || 0).toFixed(0)}/hr</span></div>
        <div class="row"><span class="label">Status</span><span class="value">⚠️ Email verification required</span></div>
      </div>
      <p>Please verify your email to activate all features:</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${verifyUrl}" class="btn">✅ Verify My Email</a>
      </div>
      <div class="warning">
        ⚠️ <strong>Community Standards Notice:</strong> Your profile is subject to our policies. Any content found violating uLearn's standards and policies may result in profile suspension or permanent removal. Please ensure all information is accurate and professional.
      </div>
    </div>
    <div class="footer"><p>© ${new Date().getFullYear()} uLearn. All rights reserved.</p></div>
  </div></body></html>`;
}

// ── Send functions ────────────────────────────────────────────────

async function sendWelcomeStudent(to, name, verifyToken) {
  const verifyUrl = `${BASE}/auth/verify-email/${verifyToken}`;
  const info = await sendMail({
    to,
    subject: '🎓 Welcome to uLearn — Please verify your email',
    html: welcomeStudentHtml(name, verifyUrl),
    text: `Welcome to uLearn, ${name}!\n\nVerify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
  });
  console.log(`[email ✓] Welcome email sent to ${to} via ${info.provider} — id: ${info.messageId}`);
  return info;
}

async function sendWelcomeTutor(to, name, subjects, hourlyRate, verifyToken) {
  const verifyUrl = `${BASE}/auth/verify-email/${verifyToken}`;
  const info = await sendMail({
    to,
    subject: '🏆 Welcome to uLearn — Your tutor profile is live!',
    html: welcomeTutorHtml(name, subjects, hourlyRate, verifyUrl),
    text: `Welcome to uLearn as a tutor, ${name}!\n\nVerify your email: ${verifyUrl}\n\nYour profile is live. Keep it professional — policy violations may result in suspension.`,
  });
  console.log(`[email ✓] Tutor welcome email sent to ${to} via ${info.provider} — id: ${info.messageId}`);
  return info;
}

async function sendVerificationEmail(to, name, verifyToken) {
  const verifyUrl = `${BASE}/auth/verify-email/${verifyToken}`;
  const info = await sendMail({
    to,
    subject: '✅ Verify your uLearn email address',
    html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
      <h2 style="color:#3b82f6">Verify your email</h2>
      <p>Hi ${name},<br><br>Click the button below to verify your uLearn account:</p>
      <a href="${verifyUrl}" style="display:inline-block;background:#3b82f6;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a>
      <p style="margin-top:20px;font-size:13px;color:#666">Link expires in 24 hours. If you didn't request this, ignore this email.</p>
    </div>`,
    text: `Verify your uLearn email: ${verifyUrl}`,
  });
  console.log(`[email ✓] Verification email sent to ${to} via ${info.provider} — id: ${info.messageId}`);
  return info;
}

module.exports = { sendWelcomeStudent, sendWelcomeTutor, sendVerificationEmail };
