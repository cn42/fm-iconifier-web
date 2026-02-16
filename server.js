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

// wie lange Konvertierungs-Ergebnisse abrufbar bleiben (ms)
const RESULT_TTL_MS = process.env.RESULT_TTL_MS ? Number(process.env.RESULT_TTL_MS) : 15 * 60 * 1000;

app.use(express.json());

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
    .slice(0, 120);
}

function isSvgName(n) {
  return n.toLowerCase().endsWith('.svg');
}

async function unzipSvgsToDir(zipBuffer, destDir) {
  // Entpacken und nur .svg übernehmen (Schutz gegen Zip Slip)
  const dir = await unzipper.Open.buffer(zipBuffer);
  for (const entry of dir.files) {
    if (entry.type !== 'File') continue;
    const base = path.basename(entry.path);
    if (!isSvgName(base)) continue;

    const outPath = path.join(destDir, safeName(base));
    // sicherstellen, dass outPath wirklich im destDir bleibt
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

// --- simple in-memory registry for results (id -> {base, outDir, createdAt}) ---
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

// --- Healthcheck ---
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// --- UI ---
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>FM SVG Icon Converter</title>
  <style>
    :root { color-scheme: light dark; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:24px;max-width:920px}
    h1{margin:0 0 8px 0}
    .sub{color:#666;margin:0 0 20px 0}
    .card{border:1px solid #ddd;border-radius:16px;padding:18px}
    .drop{
      border:2px dashed #aaa;border-radius:16px;padding:28px;text-align:center;
      transition: transform .06s ease, border-color .06s ease;
      user-select:none;
    }
    .drop.drag{border-color:#4a90e2; transform: scale(1.01);}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
    button{padding:10px 14px;border-radius:12px;border:1px solid #ccc;background:#f6f6f6;cursor:pointer}
    button:disabled{opacity:.6;cursor:not-allowed}
    input[type=file]{display:none}
    .bar{height:10px;border-radius:999px;border:1px solid #ccc;overflow:hidden;min-width:220px}
    .bar > div{height:100%;width:0%}
    .meta{font-size:14px;color:#666}
    .err{color:#b00020;white-space:pre-wrap}
    .ok{color:#0a7a2f}
    ul{margin:10px 0 0 0;padding-left:18px}
    a{word-break:break-word}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
  </style>
</head>
<body>
  <h1>FM SVG Icon Converter</h1>
  <p class="sub">Drag & Drop: <code>.svg</code> oder <code>.zip</code> (mit mehreren SVGs) → konvertierte SVGs direkt herunterladen.</p>

  <div class="card">
    <div id="drop" class="drop">
      <div style="font-size:18px;margin-bottom:6px"><b>Datei hier ablegen</b></div>
      <div class="meta">oder</div>
      <div class="row" style="justify-content:center">
        <label for="file" style="display:inline-block">
          <button type="button" id="pick">Datei auswählen</button>
        </label>
        <input id="file" type="file" accept=".svg,.zip,image/svg+xml,application/zip" />
        <button type="button" id="upload" disabled>Konvertieren</button>
      </div>
      <div class="row" style="justify-content:center">
        <div class="bar" aria-label="Fortschritt"><div id="bar"></div></div>
        <div class="meta" id="pct">0%</div>
      </div>
      <div class="meta" id="info">Max Upload: ${MAX_UPLOAD_MB} MB</div>
      <div class="err" id="err"></div>
    </div>

    <div id="result" style="margin-top:18px; display:none">
      <div class="row" style="justify-content:space-between">
        <div><b>Ergebnis</b> <span class="meta" id="rid"></span></div>
        <div class="row">
          <a id="zipAll" href="#" style="display:none"><button type="button">Alles als ZIP</button></a>
          <button type="button" id="reset">Neuer Upload</button>
        </div>
      </div>
      <div class="meta" id="ttl"></div>
      <ul id="list"></ul>
    </div>
  </div>

<script>
(() => {
  const drop = document.getElementById('drop');
  const fileInput = document.getElementById('file');
  const pickBtn = document.getElementById('pick');
  const uploadBtn = document.getElementById('upload');
  const bar = document.getElementById('bar');
  const pct = document.getElementById('pct');
  const info = document.getElementById('info');
  const err = document.getElementById('err');

  const resultBox = document.getElementById('result');
  const list = document.getElementById('list');
  const ridEl = document.getElementById('rid');
  const ttlEl = document.getElementById('ttl');
  const zipAll = document.getElementById('zipAll');
  const resetBtn = document.getElementById('reset');

  let currentFile = null;

  function setError(msg) {
    err.textContent = msg || '';
  }
  function setProgress(p) {
    const v = Math.max(0, Math.min(100, p || 0));
    bar.style.width = v + '%';
    pct.textContent = v.toFixed(0) + '%';
  }
  function resetUI() {
    currentFile = null;
    fileInput.value = '';
    uploadBtn.disabled = true;
    setProgress(0);
    setError('');
    resultBox.style.display = 'none';
    list.innerHTML = '';
    zipAll.style.display = 'none';
    zipAll.href = '#';
    ridEl.textContent = '';
    ttlEl.textContent = '';
    info.textContent = 'Max Upload: ${MAX_UPLOAD_MB} MB';
  }

  function setSelected(file) {
    currentFile = file;
    uploadBtn.disabled = !file;
    setError('');
    if (file) info.textContent = 'Ausgewählt: ' + file.name + ' (' + Math.round(file.size/1024) + ' KB)';
  }

  // Drag & Drop
  ['dragenter','dragover'].forEach(evt => {
    drop.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('drag');
    });
  });
  ['dragleave','drop'].forEach(evt => {
    drop.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('drag');
    });
  });
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setSelected(f);
  });

  // File picker
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) setSelected(f);
  });

  // Convert
  uploadBtn.addEventListener('click', async () => {
    if (!currentFile) return;

    setError('');
    setProgress(0);
    uploadBtn.disabled = true;

    const fd = new FormData();
    fd.append('file', currentFile);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setProgress((e.loaded / e.total) * 90); // Upload bis 90%
      }
    };

    xhr.onreadystatechange = async () => {
      if (xhr.readyState !== 4) return;

      if (xhr.status >= 200 && xhr.status < 300) {
        setProgress(100);
        const data = JSON.parse(xhr.responseText);

        ridEl.textContent = '(ID: ' + data.id + ')';
        ttlEl.textContent = 'Ergebnisse sind ca. ' + data.ttlMinutes + ' Minuten verfügbar.';

        list.innerHTML = '';
        for (const f of data.files) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = data.baseUrl + '/file/' + encodeURIComponent(f);
          a.textContent = f;
          a.download = f;
          li.appendChild(a);
          list.appendChild(li);
        }

        zipAll.href = data.baseUrl + '/zip';
        zipAll.style.display = data.files.length > 1 ? 'inline-block' : 'none';

        resultBox.style.display = 'block';
      } else {
        setError(xhr.responseText || ('Fehler (' + xhr.status + ')'));
        uploadBtn.disabled = false;
        setProgress(0);
      }
    };

    xhr.send(fd);
  });

  resetBtn.addEventListener('click', resetUI);

  resetUI();
})();
</script>
</body>
</html>`);
});

// --- API: convert ---
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

    // Wenn ZIP keine SVGs enthielt
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

// --- Download single file ---
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

// --- Download all as zip ---
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
