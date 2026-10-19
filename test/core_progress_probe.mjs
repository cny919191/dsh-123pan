// 探针：直接跑核心上传，记录每条 NDJSON 到达的时间，看进度事件是否在传输过程中出现
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const core = 'D:/python/plugins/dsh-123pan/native/core/123pan-core.exe';
const file = process.argv[2];
const out = `D:/python/plugins/dsh-123pan/_probe.ndjson`;
const token = process.argv[3] || '';

try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }

const env = { ...process.env };
if (token) env.DSH_123PAN_TOKEN = token;

const child = spawn(core, ['upload', '--file', file, '--parent', '0', '--ndjson', out], {
  stdio: 'ignore',
  env,
  windowsHide: true,
});

const t0 = Date.now();
let offset = 0;
let buf = '';
const timer = setInterval(() => {
  let size;
  try { size = fs.statSync(out).size; } catch { return; }
  if (size <= offset) return;
  let fd;
  try {
    fd = fs.openSync(out, 'r');
    const b = Buffer.alloc(size - offset);
    fs.readSync(fd, b, 0, b.length, offset);
    offset = size;
    buf += b.toString('utf8');
  } catch { return; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'progress') console.log(`[${dt}s] progress ${(msg.fraction * 100).toFixed(1)}%  ${msg.stage}`);
    else if (msg.type === 'result') console.log(`[${dt}s] result ok=${msg.ok} ${JSON.stringify(msg.data || msg.error).slice(0, 120)}`);
  }
}, 200);

child.on('exit', (code) => {
  clearInterval(timer);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 进程退出 code=${code}`);
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  process.exit(0);
});
