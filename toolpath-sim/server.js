const express = require('express');
const multer = require('multer');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 路径配置 — 相对于 tools_test
const TOOL_TEST_DIR = path.resolve(__dirname, '..');
const NC_DIR = path.join(TOOL_TEST_DIR, 'nc测试文件');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BINARY = path.join(TOOL_TEST_DIR, 'build', 'run_pmc_test');

// Ensure directories exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(NC_DIR)) fs.mkdirSync(NC_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/ncfiles — list NC files
app.get('/api/ncfiles', (req, res) => {
  try {
    const files = fs.readdirSync(NC_DIR)
      .filter(f => f.endsWith('.nc'))
      .sort();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ncfiles/:name/content — 返回 NC 文件内容（供右侧代码面板显示）
app.get('/api/ncfiles/:name/content', (req, res) => {
  const safeFile = path.basename(req.params.name);
  const ncPath = path.join(NC_DIR, safeFile);
  if (!fs.existsSync(ncPath)) return res.status(404).json({ error: 'file not found' });
  try {
    const content = fs.readFileSync(ncPath, 'utf-8');
    res.json({ filename: safeFile, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calculate — run C++ binary
app.post('/api/calculate', (req, res) => {
  const { file, D, cnv, cav, naa, entrySUP, entrySUV, cornerCCC, lookAheadSegments, geomCheck } = req.body;
  if (!file) return res.status(400).json({ error: 'file is required' });
  const safeFile = path.basename(file);
  const ncPath = path.join(NC_DIR, safeFile);
  if (!fs.existsSync(ncPath)) return res.status(404).json({ error: 'file not found' });
  const dVal   = typeof D   === 'number' ? D   : 6.0;
  const cnvVal = typeof cnv === 'number' ? cnv : 0;
  const cavVal = typeof cav === 'number' ? cav : 0;
  const naaVal = typeof naa === 'number' ? naa : 0;
  const supVal = typeof entrySUP === 'number' ? entrySUP : 0;
  const suvVal = typeof entrySUV === 'number' ? entrySUV : 0;
  const cccVal = typeof cornerCCC === 'number' ? cornerCCC : 0;
  const laVal  = typeof lookAheadSegments === 'number' ? lookAheadSegments : 8;
  const geomVal = typeof geomCheck === 'number' ? geomCheck : 0;   // 不相邻等距线几何相交检查
  const tmpOut = path.join(UPLOAD_DIR, `out_${crypto.randomUUID()}.json`);
  try {
    execFileSync(BINARY, [ncPath, String(dVal), String(cnvVal), String(cavVal), String(naaVal), String(supVal), String(suvVal), String(cccVal), String(laVal), String(geomVal), tmpOut], { timeout: 10000, stdio: 'ignore' });
    const data = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `C++ execution failed: ${err.message}` });
  } finally {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

// POST /api/upload — upload custom NC file
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const uploadedPath = req.file.path;
  try {
    const safeName = path.basename(req.file.originalname.replace(/\.[^.]+$/, '') + '.nc');
    const dest = path.join(NC_DIR, safeName);
    fs.copyFileSync(uploadedPath, dest);
    res.json({ filename: safeName });
  } catch (err) {
    res.status(500).json({ error: `upload failed: ${err.message}` });
  } finally {
    if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
  }
});

app.listen(PORT, () => {
  console.log(`Toolpath Sim running at http://localhost:${PORT}`);
  console.log(`  NC files: ${NC_DIR}`);
  console.log(`  Binary:   ${BINARY}`);
});
