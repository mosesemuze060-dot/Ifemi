const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'ifemi_super_secret_2024';

// ─── In-Memory "Database" (replace with MongoDB in production) ───────────────
const users = new Map();       // phone -> userObj
const otps = new Map();        // phone -> otp
const messages = new Map();    // roomId -> [messages]
const groups = new Map();      // groupId -> groupObj
const onlineUsers = new Map(); // socketId -> phone

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getRoomId(phoneA, phoneB) {
  return [phoneA, phoneB].sort().join('_');
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

// Send OTP
app.post('/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  const otp = generateOTP();
  otps.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });

  // In production: send via Twilio/Termii
  console.log(`📱 OTP for ${phone}: ${otp}`);

  res.json({
    success: true,
    message: 'OTP sent',
    // Remove this in production - only for demo
    demo_otp: otp,
  });
});

// Verify OTP & Register/Login
app.post('/auth/verify-otp', (req, res) => {
  const { phone, otp, name } = req.body;
  const stored = otps.get(phone);

  if (!stored) return res.status(400).json({ error: 'No OTP sent' });
  if (Date.now() > stored.expires) return res.status(400).json({ error: 'OTP expired' });
  if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });

  otps.delete(phone);

  let user = users.get(phone);
  if (!user) {
    user = {
      id: uuidv4(),
      phone,
      name: name || phone,
      avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${phone}`,
      status: 'Hey there! I am using Ifemi',
      createdAt: new Date().toISOString(),
      contacts: [],
    };
    users.set(phone, user);
  }

  const token = jwt.sign({ phone, id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user });
});

// ─── USER ROUTES ──────────────────────────────────────────────────────────────

app.get('/user/profile', authMiddleware, (req, res) => {
  const user = users.get(req.user.phone);
  res.json(user);
});

app.put('/user/profile', authMiddleware, (req, res) => {
  const user = users.get(req.user.phone);
  const { name, status, avatar } = req.body;
  if (name) user.name = name;
  if (status) user.status = status;
  if (avatar) user.avatar = avatar;
  users.set(req.user.phone, user);
  res.json(user);
});

app.get('/user/find/:phone', authMiddleware, (req, res) => {
  const user = users.get(req.params.phone);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, phone: user.phone, name: user.name, avatar: user.avatar, status: user.status });
});

app.post('/user/add-contact', authMiddleware, (req, res) => {
  const { contactPhone } = req.body;
  const contact = users.get(contactPhone);
  if (!contact) return res.status(404).json({ error: 'User not found on Ifemi' });

  const user = users.get(req.user.phone);
  if (!user.contacts.includes(contactPhone)) {
    user.contacts.push(contactPhone);
    users.set(req.user.phone, user);
  }

  res.json({ success: true, contact: { id: contact.id, phone: contact.phone, name: contact.name, avatar: contact.avatar, status: contact.status } });
});

app.get('/user/contacts', authMiddleware, (req, res) => {
  const user = users.get(req.user.phone);
  const contacts = (user.contacts || []).map(phone => {
    const c = users.get(phone);
    if (!c) return null;
    return { id: c.id, phone: c.phone, name: c.name, avatar: c.avatar, status: c.status };
  }).filter(Boolean);
  res.json(contacts);
});

// ─── MESSAGE ROUTES ───────────────────────────────────────────────────────────

app.get('/messages/:contactPhone', authMiddleware, (req, res) => {
  const roomId = getRoomId(req.user.phone, req.params.contactPhone);
  const msgs = messages.get(roomId) || [];
  res.json(msgs);
});

// ─── GROUP ROUTES ─────────────────────────────────────────────────────────────

app.post('/groups/create', authMiddleware, (req, res) => {
  const { name, members } = req.body;
  const group = {
    id: uuidv4(),
    name,
    avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`,
    members: [req.user.phone, ...(members || [])],
    admins: [req.user.phone],
    createdBy: req.user.phone,
    createdAt: new Date().toISOString(),
  };
  groups.set(group.id, group);
  messages.set(`group_${group.id}`, []);
  res.json(group);
});

app.get('/groups', authMiddleware, (req, res) => {
  const userGroups = [];
  for (const [, group] of groups) {
    if (group.members.includes(req.user.phone)) {
      userGroups.push(group);
    }
  }
  res.json(userGroups);
});

app.get('/groups/:groupId/messages', authMiddleware, (req, res) => {
  const msgs = messages.get(`group_${req.params.groupId}`) || [];
  res.json(msgs);
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const { phone } = socket.user;
  onlineUsers.set(socket.id, phone);

  // Join personal room
  socket.join(phone);
  io.emit('user:online', { phone, online: true });

  console.log(`✅ ${phone} connected`);

  // ── Private Message ──
  socket.on('message:send', ({ toPhone, content, type = 'text' }) => {
    const roomId = getRoomId(phone, toPhone);
    const msg = {
      id: uuidv4(),
      from: phone,
      to: toPhone,
      content,
      type,
      timestamp: new Date().toISOString(),
      status: 'sent',
    };

    if (!messages.has(roomId)) messages.set(roomId, []);
    messages.get(roomId).push(msg);

    // Send to recipient
    io.to(toPhone).emit('message:receive', msg);
    // Confirm to sender
    socket.emit('message:sent', msg);
  });

  // ── Group Message ──
  socket.on('group:message:send', ({ groupId, content, type = 'text' }) => {
    const group = groups.get(groupId);
    if (!group || !group.members.includes(phone)) return;

    const msg = {
      id: uuidv4(),
      groupId,
      from: phone,
      content,
      type,
      timestamp: new Date().toISOString(),
    };

    const key = `group_${groupId}`;
    if (!messages.has(key)) messages.set(key, []);
    messages.get(key).push(msg);

    // Send to all group members
    group.members.forEach(member => {
      io.to(member).emit('group:message:receive', msg);
    });
  });

  // ── Typing indicators ──
  socket.on('typing:start', ({ toPhone }) => {
    io.to(toPhone).emit('typing:start', { from: phone });
  });

  socket.on('typing:stop', ({ toPhone }) => {
    io.to(toPhone).emit('typing:stop', { from: phone });
  });

  // ── Message read ──
  socket.on('message:read', ({ from }) => {
    io.to(from).emit('message:read', { by: phone });
  });

  // ── WebRTC Signaling (Voice/Video Calls) ──
  socket.on('call:initiate', ({ toPhone, offer, callType }) => {
    io.to(toPhone).emit('call:incoming', {
      from: phone,
      offer,
      callType,
      callerInfo: users.get(phone),
    });
  });

  socket.on('call:answer', ({ toPhone, answer }) => {
    io.to(toPhone).emit('call:answered', { answer });
  });

  socket.on('call:ice-candidate', ({ toPhone, candidate }) => {
    io.to(toPhone).emit('call:ice-candidate', { candidate });
  });

  socket.on('call:end', ({ toPhone }) => {
    io.to(toPhone).emit('call:ended', { from: phone });
  });

  socket.on('call:reject', ({ toPhone }) => {
    io.to(toPhone).emit('call:rejected', { by: phone });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('user:online', { phone, online: false });
    console.log(`❌ ${phone} disconnected`);
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Ifemi Server running on port ${PORT}`);
});
