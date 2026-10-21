// 卫戍协议诊断的 node 基础检查（DiagActivity 用离线版的 libnode.so 以 `node -e` 运行）：
// 服务端启动会用到的运行时能力逐项试一遍，每项出错单独记下，不中断后面的。端口取环境变量 GAME_PORT。
const os = require('os'), net = require('net'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const out = (k, v) => console.log('  ' + k + ': ' + v);
const t = (k, f) => { try { out(k, f()); } catch (e) { out(k, 'ERROR ' + (e.code || '') + ' ' + e.message); } };

t('versions', () => JSON.stringify({ node: process.versions.node, uv: process.versions.uv,
  openssl: process.versions.openssl, icu: process.versions.icu }));
t('platform', () => process.platform + ' ' + process.arch + ' ' + os.release());
t('networkInterfaces', () => Object.keys(os.networkInterfaces()).join(',') || '(none)');
t('cpus', () => os.cpus().length);
t('memory', () => Math.round(os.totalmem() / 1048576) + 'MB total, ' + Math.round(os.freemem() / 1048576) + 'MB free');
t('crypto', () => crypto.createHash('sha256').update('x').digest('hex').slice(0, 8) + ' ' + crypto.randomUUID());
t('Intl', () => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' }).format(new Date(0)));
t('tmpdir', () => {
  const p = path.join(os.tmpdir(), 'diag-probe.txt');
  fs.writeFileSync(p, 'ok');
  const s = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  return os.tmpdir() + ' ' + s;
});

const listen = (port) => new Promise((res) => {
  const s = net.createServer();
  s.once('error', (e) => res('ERROR ' + e.code + ' ' + e.message));
  s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => res('ok ' + p)); });
});
(async () => {
  const port = Number(process.env.GAME_PORT || 3000);
  out('listen 127.0.0.1:' + port, await listen(port));
  out('listen 127.0.0.1:0', await listen(0));
})();
