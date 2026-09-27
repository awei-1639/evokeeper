#!/usr/bin/env node
// 本地 golden set 标注工具（零依赖）
// 启动: node scripts/annotate.mjs  →  http://localhost:8765
// 首次启动自动备份草稿池为 datasets/drafts/alibaba_nacos.jsonl.backup.jsonl
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// ANNOTATE_DATA 可指向其他 JSONL（如盲标子集 datasets/review/blind-round2.jsonl），便于第二轮复标
const DATA = process.env.ANNOTATE_DATA
  ? path.resolve(ROOT, process.env.ANNOTATE_DATA)
  : path.join(ROOT, 'datasets', 'drafts', 'alibaba_nacos.jsonl');
const BACKUP = DATA + '.backup.jsonl';
const HTML = path.join(__dirname, 'annotate.html');
const PORT = 8765;

if (!fs.existsSync(BACKUP)) fs.copyFileSync(DATA, BACKUP);

function readItems() {
  return fs
    .readFileSync(DATA, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

function writeItems(items) {
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, DATA);
}

function nextId(items) {
  let max = 0;
  for (const it of items) {
    const m = /^gs-(\d+)$/.exec(it.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'gs-' + String(max + 1).padStart(4, '0');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/items') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ items: readItems(), backup: BACKUP }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        const items = readItems();
        const idx = items.findIndex(
          (i) => i.issue_number === patch.issue_number && i.repo === patch.repo
        );
        if (idx < 0) throw new Error('issue not found: ' + patch.issue_number);
        const it = items[idx];
        it.labels_gold = patch.labels_gold;
        it.triage_rationale = patch.triage_rationale;
        it.difficulty = patch.difficulty;
        it.split = patch.split;
        it.annotator = patch.annotator;
        it.annotated_at = patch.annotated_at;
        it.qa = patch.qa;
        if (!it.id || it.id === 'TBD') it.id = nextId(items);
        writeItems(items);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: it.id }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`标注工具已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DATA}`);
  console.log(`已备份至: ${BACKUP}`);
});
