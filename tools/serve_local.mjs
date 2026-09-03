/**
 * 本地一体化预览服务器（不需要 wrangler / Cloudflare 账号）
 *   - 静态服务 public/
 *   - /api/*  直接跑 src/worker.js（用内存 SQLite 模拟 D1）
 * 运行: node --experimental-sqlite tools/serve_local.mjs
 * 打开: http://localhost:8787
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { importCsv } from '../src/worker.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        all() { return Promise.resolve({ results: sqlite.prepare(sql).all(...args) }); },
        run() {
          const r = sqlite.prepare(sql).run(...args);
          return Promise.resolve({ meta: { changes: Number(r.changes) } });
        },
        first() {
          return Promise.resolve(sqlite.prepare(sql).all(...args)[0] || null);
        },
      };
      return stmt;
    },
    batch(stmts) {
      for (const s of stmts) s.run();
      return Promise.resolve([]);
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'POST' || req.method === 'PUT'
      ? await new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => r(b)); })
      : null;
    const request = new Request('http://localhost' + req.url, {
      method: req.method,
      headers: req.headers,
      body: body || undefined,
    });
    const env = { DB: d1Adapter(db) };
    try {
      const out = await worker.fetch(request, env, {});
      const text = await out.text();
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(text);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }

  let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`RoomSense 看板已启动: http://localhost:${PORT}`);
  console.log(`数据后台: http://localhost:${PORT}/admin.html`);
});
