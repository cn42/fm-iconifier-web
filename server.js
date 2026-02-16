'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const unzipper = require('unzipper');
const archiver = require('archiver');

const gulp = require('gulp');
const { convert, ensureDirectories, files } = require('gulp-fm-icon-converter');

const app = express();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const MAX_UPLOAD_MB = process.env.MAX_UPLOAD_MB ? Number(process.env.MAX_UPLOAD_MB) : 25;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const RESULT_TTL_MS = process.env.RESULT_TTL_MS ? Number(process.env.RESULT_TTL_MS) : 15 * 60 * 1000;

// ---- Upload handling ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

function rid() {
  return crypto.randomBytes(12).toString('hex');
}

function safeName(name) {
  return (name || 'file.svg')
    .toString()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 140);
}

function isSvgName(n) {
  return n.toLowerCase().endsWith('.svg');
}

async function unzipSvgsToDir(zipBuffer, destDir) {
  const dir = await unzipper.Open.buffer(zipBuffer);
  for (const entry of dir.files) {
    if (entry.type !== 'File') continue;

    const base = path.basename(entry.path);
    if (!isSvgName(base)) continue;

    const outPath = path.join(destDir, safeName(base));
    const resolved = path.resolve(outPath);
    if (!resolved.startsWith(path.resolve(destDir) + path.sep)) continue;

    await new Promise((resolve, reject) => {
      entry
        .stream()
        .pipe(fs.createWriteStream(outPath))
        .on('finish', resolve)
        .on('error', reject);
    });
  }
}

async function runGulpConvert(srcDir, outDir) {
  await new Promise((resolve, reject) => {
    const s = gulp
      .src(files(srcDir), { allowEmpty: true })
      .pipe(convert())
      .pipe(gulp.dest(outDir));

    s.on('error', reject);
    s.on('finish', resolve);
    s.on('end', resolve);
  });
}

async function listSvgFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && isSvgName(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function zipDirToRes(dirPath, res, zipName) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    throw err;
  });
  archive.pipe(res);
  archive.directory(dirPath, false);
  await archive.finalize();
}

// ---- Results registry (id -> { base, outDir, createdAt }) ----
const results = new Map();

async function cleanupExpired() {
  const now = Date.now();
  for (const [id, r] of results.entries()) {
    if (now - r.createdAt > RESULT_TTL_MS) {
      results.delete(id);
      try { await fsp.rm(r.base, { recursive: true, force: true }); } catch {}
    }
  }
}
setInterval(cleanupExpired, 60 * 1000).unref();

// ---- Anti-crawl / anti-ai headers (global) ----
// 1) X-Robots-Tag is the strongest general mechanism for HTTP responses.
// 2) Add common AI/preview discouragement headers used by some crawlers.
app.use((req, res, next) => {
  res.setHeader(
    'X-Robots-Tag',
    'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate, nocache'
  );
  // Some crawlers look for these (not standardized, but harmless):
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ---- Static (index.html + robots.txt) ----
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  // ensure headers also on static
  setHeaders: (res) => {
    res.setHeader(
      'X-Robots-Tag',
      'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate, nocache'
    );
  }
}));

// ---- Healthcheck ----
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---- API: Convert ----
app.post('/api/convert', upload.single('file'), async (req, res) => {
  const id = rid();
  const base = path.join(os.tmpdir(), `fmconv-${id}`);
  const srcDir = path.join(base, 'standard-icons');
  const outDir = path.join(base, 'fm-icons');

  try {
    if (!req.file) return res.status(400).send('Keine Datei erhalten.');

    await fsp.mkdir(base, { recursive: true });
    ensureDirectories(srcDir, outDir);

    const original = req.file.originalname || 'upload';
    const ext = path.extname(original).toLowerCase();

    if (ext === '.zip') {
      await unzipSvgsToDir(req.file.buffer, srcDir);
    } else if (ext === '.svg') {
      const name = safeName(path.basename(original));
      await fsp.writeFile(path.join(srcDir, name), req.file.buffer);
    } else {
      return res.status(400).send('Bitte nur .svg oder .zip hochladen.');
    }

    const pre = await listSvgFiles(srcDir);
    if (pre.length === 0) return res.status(400).send('Keine SVGs gefunden.');

    await runGulpConvert(srcDir, outDir);

    const outFiles = await listSvgFiles(outDir);
    if (outFiles.length === 0) return res.status(500).send('Konvertierung lieferte keine SVGs.');

    results.set(id, { base, outDir, createdAt: Date.now() });

    const baseUrl = `/r/${id}`;
    res.json({
      id,
      files: outFiles,
      baseUrl,
      ttlMinutes: Math.round(RESULT_TTL_MS / 60000)
    });
  } catch (e) {
    console.error(e);
    try { await fsp.rm(base, { recursive: true, force: true }); } catch {}
    res.status(500).send('Fehler bei der Verarbeitung.');
  }
});

// ---- Download: single file ----
app.get('/r/:id/file/:name', async (req, res) => {
  try {
    const id = req.params.id;
    const name = safeName(req.params.name);
    const r = results.get(id);
    if (!r) return res.status(404).send('Nicht gefunden oder abgelaufen.');

    const p = path.join(r.outDir, name);
    const resolved = path.resolve(p);
    if (!resolved.startsWith(path.resolve(r.outDir) + path.sep)) return res.status(400).send('Ungültiger Pfad.');

    await fsp.access(p, fs.constants.R_OK);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    fs.createReadStream(p).pipe(res);
  } catch {
    res.status(404).send('Datei nicht gefunden.');
  }
});

// ---- Download: all as zip ----
app.get('/r/:id/zip', async (req, res) => {
  try {
    const id = req.params.id;
    const r = results.get(id);
    if (!r) return res.status(404).send('Nicht gefunden oder abgelaufen.');

    const zipName = `fm-icons-${id}.zip`;
    await zipDirToRes(r.outDir, res, zipName);
  } catch (e) {
    console.error(e);
    res.status(500).send('ZIP Erstellung fehlgeschlagen.');
  }
});

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
