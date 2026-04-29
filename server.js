require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve admin panel static files
app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

// ─── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  try {
    const payload = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }
}

// ─── Auth routes ────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (password !== adminPassword) {
    return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
  }

  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, token });
});

// ─── API Routes ─────────────────────────────────────────────────────────────
const adminRoutes = require('./routes/admin');
const launcherRoutes = require('./routes/launcher');

// Admin routes (protected)
app.use('/api/admin', requireAuth, adminRoutes);

// Launcher routes (public)
app.use('/api/launcher', launcherRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'online', timestamp: new Date().toISOString() });
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🎮 Minecraft Launcher Backend       ║
║   Puerto: ${PORT}                        ║
║   Panel Admin: http://localhost:${PORT}/admin ║
╚═══════════════════════════════════════╝
  `);
});

module.exports = app;
