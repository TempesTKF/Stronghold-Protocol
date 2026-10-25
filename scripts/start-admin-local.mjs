#!/usr/bin/env node
// Local-only launch: the game and owner console bind loopback unless explicitly configured.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const config = path.join(root, '.admin/config.json');
if (!fs.existsSync(config)) throw new Error('先运行 node scripts/configure-admin.mjs 设置管理员密码');
const admin = JSON.parse(fs.readFileSync(config, 'utf8'));
admin.stateFile ||= path.join(root, '.admin/state.json');
process.env.SP_BOT_STRATEGY ??= 'owner';
const srv = await startServer({ host: '127.0.0.1', port: Number(process.env.PORT || 3000), admin });
console.log(`游戏主页: ${srv.url}/`);
console.log(`管理后台: http://127.0.0.1:${srv.admin.server.address().port}/`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (stopping) return;
  stopping = true;
  await srv.close();
});
