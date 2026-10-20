#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { passwordRecord } from '../server/admin/auth.js';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.stdin.isTTY) throw new Error('请在交互式终端中运行，以隐藏密码输入');
let muted = false;
const output = new Writable({ write(chunk, encoding, next) { if (!muted) process.stdout.write(chunk, encoding); next(); } });
const input = readline.createInterface({ input: process.stdin, output, terminal: true });
async function ask(prompt) {
  process.stdout.write(prompt);
  muted = true;
  try { return await input.question(''); }
  finally { muted = false; process.stdout.write('\n'); }
}
try {
  const password = await ask('设置管理员密码（至少 8 位，输入隐藏）: ');
  const confirm = await ask('再次输入: ');
  if (password.length < 8 || password.length > 256 || password !== confirm) throw new Error('密码长度不符或两次输入不一致');
  const file = path.join(root, '.admin/config.json');
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { host: '127.0.0.1', port: 3001 };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ ...old, password: await passwordRecord(password) }, null, 2) + '\n', { mode: 0o600 });
  console.log('密码哈希已保存。重新启动本地服务后生效。');
} finally { input.close(); }
