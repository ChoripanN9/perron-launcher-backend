const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

// Configure multer for mrpack uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || 500) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.mrpack') || file.mimetype === 'application/zip') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos .mrpack'));
    }
  }
});

// GET /api/admin/modpacks - List all modpacks
router.get('/modpacks', (req, res) => {
  try {
    const data = require('../database.js');
    const fs = require('fs');
    const path = require('path');
    const dbFile = path.join(__dirname, '../data.json');
    const db2 = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const modpacks = (db2.modpacks || []).map(m => ({
      ...m,
      code_count: (db2.codes || []).filter(c => c.modpack_id === m.id).length
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, modpacks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/modpacks - Upload new modpack
router.post('/modpacks', upload.single('mrpack'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No se subió ningún archivo' });

    const { name, description, version, minecraft_version, modloader, modloader_version } = req.body;
    if (!name || !version || !minecraft_version || !modloader) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO modpacks (id, name, description, version, minecraft_version, modloader, modloader_version, filename, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description || '', version, minecraft_version, modloader, modloader_version || '', req.file.filename, req.file.size);

    res.json({ success: true, modpack: { id, name, version, minecraft_version, modloader } });
  } catch (err) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/modpacks/:id - Delete a modpack
router.delete('/modpacks/:id', (req, res) => {
  try {
    const modpack = db.prepare('SELECT * FROM modpacks WHERE id = ?').get(req.params.id);
    if (!modpack) return res.status(404).json({ success: false, error: 'Modpack no encontrado' });

    // Delete file
    const filePath = path.join(__dirname, '../uploads', modpack.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.prepare('DELETE FROM modpacks WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/codes - List all codes
router.get('/codes', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const db2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8'));
    const codes = (db2.codes || []).map(c => {
      const mp = (db2.modpacks || []).find(m => m.id === c.modpack_id) || {};
      return { ...c, modpack_name: mp.name || '?', modpack_version: mp.version || '?' };
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, codes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/codes - Create a new code
router.post('/codes', (req, res) => {
  try {
    const { modpack_id, description, max_uses, custom_code } = req.body;
    if (!modpack_id) return res.status(400).json({ success: false, error: 'modpack_id requerido' });

    const modpack = db.prepare('SELECT id FROM modpacks WHERE id = ?').get(modpack_id);
    if (!modpack) return res.status(404).json({ success: false, error: 'Modpack no encontrado' });

    // Generate or use custom code
    let code = custom_code ? custom_code.toUpperCase() : generateCode();

    // Check if code already exists
    const existing = db.prepare('SELECT id FROM codes WHERE code = ?').get(code);
    if (existing) return res.status(409).json({ success: false, error: 'El código ya existe' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO codes (id, code, modpack_id, description, max_uses)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, code, modpack_id, description || '', max_uses || -1);

    res.json({ success: true, code: { id, code, modpack_id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/codes/:id
router.delete('/codes/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM codes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/codes/:id/toggle - Enable/disable a code
router.patch('/codes/:id/toggle', (req, res) => {
  try {
    const code = db.prepare('SELECT * FROM codes WHERE id = ?').get(req.params.id);
    if (!code) return res.status(404).json({ success: false, error: 'Código no encontrado' });
    db.prepare('UPDATE codes SET active = ? WHERE id = ?').run(code.active ? 0 : 1, req.params.id);
    res.json({ success: true, active: !code.active });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const db2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8'));
    const recentDownloads = (db2.download_logs || [])
      .map(dl => {
        const mp = (db2.modpacks || []).find(m => m.id === dl.modpack_id) || {};
        return { ...dl, modpack_name: mp.name || '?' };
      })
      .sort((a, b) => new Date(b.downloaded_at) - new Date(a.downloaded_at))
      .slice(0, 10);
    res.json({ success: true, stats: {
      totalModpacks: (db2.modpacks || []).length,
      totalCodes: (db2.codes || []).length,
      totalDownloads: (db2.download_logs || []).length,
      recentDownloads
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

module.exports = router;
