const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'ifemi_super_secret_2024';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Ifemi:Baguvix_21@cluster0.pfdfz4f.mongodb.net/ifemi?appName=Cluster0';

// ─── MongoDB Schemas ──────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  phone: { type: String, unique: true },
  name: String,
  avatar: String,
  status: { type: String, default: 'Hey there! I am using Ifemi' },
  contacts: [String],
  createdAt: { type: Date, default: Date.now },
});

const otpSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  otp: String,
  expires: Date,
});

const messageSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  roomId: String,
  groupId: String,
  from: String,
  to: String,
  content: String,
  type: { type: String, default: 'text' },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'sent' },
});

const groupSchema = new mongoose.Schema({
  id: { type: String, default: () => uuidv4() },
  name: String,
  avatar: String,
  members: [String],
  admins: [String],
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const OTP = mongoose.model('OTP', otpSchema);
const Message = mongoose.model('Message', messageSchema);
const Group = mongoose.model('Group', groupSchema);

// ─── Connect to MongoDB ───────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

const onlineUsers = new Map();

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const otp = generateOTP();
  await OTP.findOneAndUpdate(
    { phone },
    { otp, expires: new Date(Date.now() + 5 * 60 * 1000) },
    { upsert: true, new: true }
  );
  console.log(`📱 OTP for ${phone}: ${otp}`);
  res.json({ success: true, message: 'OTP sent', demo_otp: otp });
});

app.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp, name } = req.body;
  const stored = await OTP.findOne({ phone });
  if (!stored) return res.status(400).json({ error: 'No OTP sent' });
  if (new Date() > stored.expires) return res.status(400).json({ error: 'OTP expired' });
  if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
  await OTP.deleteOne({ phone });

  let user = await User.findOne({ phone });
  if (!user) {
    user = await User.create({
      phone,
      name: name || phone,
      avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${phone}`,
    });
  }

  const token = jwt.sign({ phone, id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user });
});

// ─── USER ROUTES ──────────────────────────────────────────────────────────────

app.get('/user/profile', authMiddleware, async (req, res) => {
  const user = await User.findOne({ phone: req.user.phone });
  res.json(user);
});

app.put('/user/profile', authMiddleware, async (req, res) => {
  const { name, status, avatar } = req.body;
  const user = await User.findOneAndUpdate(
    { phone: req.user.phone },
    { name, status, avatar },
    { new: true }
  );
  res.json(user);
});

app.get('/user/find/:phone', authMiddleware, async (req, res) => {
  const user = await User.findOne({ phone: req.params.phone });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, phone: user.phone, name: user.name, avatar: user.avatar, status: user.status });
});

app.post('/user/add-contact', authMiddleware, async (req, res) => {
  const { contactPhone } = req.body;
  const contact = await User.findOne({ phone: contactPhone });
  if (!contact) return res.status(404).json({ error: 'User not found on Ifemi' });
  await User.findOneAndUpdate(
    { phone: req.user.phone },
    { $addToSet: { contacts: contactPhone } }
  );
  res.json({ success: true, contact: { id: contact.id, phone: contact.phone, name: contact.name, avatar: contact.avatar, status: contact.status } });
});

app.get('/user/contacts', authMiddleware, async (req, res) => {
  const user = await User.findOne({ phone: req.user.phone });
  const contacts = await User.find({ phone: { $in: user.contacts || [] } });
  res.json(contacts.map(c => ({ id: c.id, phone: c.phone, name: c.name, avatar: c.avatar, status: c.status })));
});

// ─── MESSAGE ROUTES ───────────────────────────────────────────────────────────

app.get('/messages/:contactPhone', authMiddleware, async (req, res) => {
  const roomId = getRoomId(req.user.phone, req.params.contactPhone);
  const msgs = await Message.find({ roomId }).sort({ timestamp: 1 }).limit(100);
  res.json(msgs);
});

// ─── GROUP ROUTES ─────────────────────────────────────────────────────────────

app.post('/groups/create', authMiddleware, async (req, res) => {
  const { name, members } = req.body;
  const group = await Group.create({
    name,
    avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${name}`,
    members: [req.user.phone, ...(members || [])],
    admins: [req.user.phone],
    createdBy: req.user.phone,
  });
  res.json(group);
});

app.get('/groups', authMiddleware, async (req, res) => {
  const groups = await Group.find({ members: req.user.phone });
  res.json(groups);
});

app.get('/groups/:groupId/messages', authMiddleware, async (req, res) => {
  const msgs = await Message.find({ groupId: req.params.groupId }).sort({ timestamp: 1 }).limit(100);
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

io.on('connection', async (socket) => {
  const { phone } = socket.user;
  onlineUsers.set(socket.id, phone);
  socket.join(phone);
  io.emit('user:online', { phone, online: true });
  console.log(`✅ ${phone} connected`);

  socket.on('message:send', async ({ toPhone, content, type = 'text' }) => {
    const roomId = getRoomId(phone, toPhone);
    const msg = await Message.create({ roomId, from: phone, to: toPhone, content, type });
    io.to(toPhone).emit('message:receive', msg);
    socket.emit('message:sent', msg);
  });

  socket.on('group:message:send', async ({ groupId, content, type = 'text' }) => {
    const group = await Group.findOne({ id: groupId });
    if (!group || !group.members.includes(phone)) return;
    const msg = await Message.create({ groupId, from: phone, content, type });
    group.members.forEach(member => {
      io.to(member).emit('group:message:receive', msg);
    });
  });

  socket.on('typing:start', ({ toPhone }) => {
    io.to(toPhone).emit('typing:start', { from: phone });
  });

  socket.on('typing:stop', ({ toPhone }) => {
    io.to(toPhone).emit('typing:stop', { from: phone });
  });

  socket.on('message:read', ({ from }) => {
    io.to(from).emit('message:read', { by: phone });
  });

  socket.on('call:initiate', ({ toPhone, offer, callType }) => {
    User.findOne({ phone }).then(caller => {
      io.to(toPhone).emit('call:incoming', { from: phone, offer, callType, callerInfo: caller });
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

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('user:online', { phone, online: false });
    console.log(`❌ ${phone} disconnected`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Ifemi Server running on port ${PORT}`);
});
