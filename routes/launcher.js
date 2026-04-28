const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../database');

// GET /api/launcher/resolve/:code - Resolve a code to modpack info
router.get('/resolve/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();

    const codeData = db.prepare(`
      SELECT c.*, m.id as modpack_id, m.name, m.description, m.version,
             m.minecraft_version, m.modloader, m.modloader_version,
             m.filename, m.file_size, m.thumbnail_url
      FROM codes c
      JOIN modpacks m ON m.id = c.modpack_id
      WHERE c.code = ?
    `).get(code);

    if (!codeData) {
      return res.status(404).json({ success: false, error: 'Código no válido' });
    }

    if (!codeData.active) {
      return res.status(403).json({ success: false, error: 'Este código ha sido desactivado' });
    }

    if (codeData.max_uses !== -1 && codeData.uses >= codeData.max_uses) {
      return res.status(403).json({ success: false, error: 'Este código ha alcanzado el límite de usos' });
    }

    res.json({
      success: true,
      modpack: {
        id: codeData.modpack_id,
        name: codeData.name,
        description: codeData.description,
        version: codeData.version,
        minecraft_version: codeData.minecraft_version,
        modloader: codeData.modloader,
        modloader_version: codeData.modloader_version,
        file_size: codeData.file_size,
        thumbnail_url: codeData.thumbnail_url,
        download_url: `/api/launcher/download/${codeData.code}`
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/launcher/download/:code - Download the mrpack file
router.get('/download/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();

    const codeData = db.prepare(`
      SELECT c.*, m.filename, m.name
      FROM codes c
      JOIN modpacks m ON m.id = c.modpack_id
      WHERE c.code = ?
    `).get(code);

    if (!codeData || !codeData.active) {
      return res.status(404).json({ success: false, error: 'Código no válido' });
    }

    if (codeData.max_uses !== -1 && codeData.uses >= codeData.max_uses) {
      return res.status(403).json({ success: false, error: 'Límite de usos alcanzado' });
    }

    const filePath = path.join(__dirname, '../uploads', codeData.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Archivo no encontrado en el servidor' });
    }

    // Increment use count
    db.prepare('UPDATE codes SET uses = uses + 1 WHERE code = ?').run(code);

    // Log download
    db.prepare(`
      INSERT INTO download_logs (code, modpack_id, ip_address)
      VALUES (?, ?, ?)
    `).run(code, codeData.modpack_id, req.ip);

    // Send file
    const safeName = codeData.name.replace(/[^a-zA-Z0-9-_. ]/g, '') + '.mrpack';
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', 'application/zip');
    res.sendFile(filePath);

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/launcher/version - Get launcher version info
router.get('/version', (req, res) => {
  res.json({
    success: true,
    launcher_version: '1.0.0',
    min_required_version: '1.0.0'
  });
});

module.exports = router;
