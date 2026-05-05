// Force IPv4 DNS resolution globally — fixes ENETUNREACH on Render/cloud (Node 17+ defaults to IPv6)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// Configure SMTP transporter
let transporter = null;

// Test SMTP connection
app.post('/api/connect', async (req, res) => {
  const { host, port, secure, user, pass } = req.body;
  try {
    transporter = nodemailer.createTransport({
      host: host || 'smtp.gmail.com',
      port: parseInt(port) || 587,
      secure: secure === true || port === '465',
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
      family: 4,              // Force IPv4
      connectionTimeout: 10000, // 10s to establish TCP connection
      greetingTimeout: 10000,   // 10s for SMTP greeting
      socketTimeout: 15000      // 15s idle socket timeout
    });

    // Race verify() against a 12-second timeout
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out. Check your host/port or App Password.')), 12000)
      )
    ]);
    res.json({ success: true, message: 'SMTP connected successfully!' });
  } catch (err) {
    transporter = null;
    res.status(400).json({ success: false, message: err.message });
  }
});

// Parse CSV upload
app.post('/api/parse-csv', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const emails = [];
  const stream = Readable.from(req.file.buffer.toString());
  stream
    .pipe(csv())
    .on('data', (row) => {
      const email = row.email || row.Email || row.EMAIL || Object.values(row)[0];
      const name = row.name || row.Name || row.NAME || '';
      if (email && email.includes('@')) emails.push({ email: email.trim(), name: name.trim() });
    })
    .on('end', () => res.json({ success: true, emails }))
    .on('error', (err) => res.status(500).json({ success: false, message: err.message }));
});

// Send bulk emails
app.post('/api/send', async (req, res) => {
  if (!transporter) return res.status(400).json({ success: false, message: 'SMTP not connected. Please configure first.' });

  const { from, fromName, recipients, subject, body, isHtml, delay } = req.body;

  if (!recipients || recipients.length === 0) {
    return res.status(400).json({ success: false, message: 'No recipients provided' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sent = 0, failed = 0;
  const results = [];
  const delayMs = parseInt(delay) || 500;

  for (const recipient of recipients) {
    const toEmail = typeof recipient === 'string' ? recipient : recipient.email;
    const toName = typeof recipient === 'object' ? recipient.name : '';

    // Replace {{name}} placeholder
    const personalizedSubject = subject.replace(/\{\{name\}\}/gi, toName || toEmail.split('@')[0]);
    const personalizedBody = body.replace(/\{\{name\}\}/gi, toName || toEmail.split('@')[0]);

    try {
      await transporter.sendMail({
        from: fromName ? `"${fromName}" <${from}>` : from,
        to: toName ? `"${toName}" <${toEmail}>` : toEmail,
        subject: personalizedSubject,
        [isHtml ? 'html' : 'text']: personalizedBody,
      });
      sent++;
      results.push({ email: toEmail, status: 'sent' });
      res.write(`data: ${JSON.stringify({ type: 'progress', email: toEmail, status: 'sent', sent, failed, total: recipients.length })}\n\n`);
    } catch (err) {
      failed++;
      results.push({ email: toEmail, status: 'failed', error: err.message });
      res.write(`data: ${JSON.stringify({ type: 'progress', email: toEmail, status: 'failed', error: err.message, sent, failed, total: recipients.length })}\n\n`);
    }

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  res.write(`data: ${JSON.stringify({ type: 'done', sent, failed, total: recipients.length, results })}\n\n`);
  res.end();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Email Blast Platform running at http://localhost:${PORT}\n`);
});
