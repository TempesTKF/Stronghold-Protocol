import { t } from '../../shared/i18n.js';
import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return { salt, hash: key.toString('hex') };
}
export function createAdminAuth(record) {
  if (!record || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{128}$/.test(record.hash)) throw new Error('Invalid admin password hash');
  const sessions = new Map(), attempts = new Map();
  let working = 0;
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value <= now) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  };
  return {
    async login(password, ip) {
      prune();
      const attempt = attempts.get(ip) || { count: 0, until: Date.now() + 15 * 60_000 };
      if (attempt.count >= 5 || working >= 2 || attempts.size >= 2048) return { status: 429, error: t('登录尝试过多，请稍后再试') };
      attempt.count++; attempts.set(ip, attempt);
      if (typeof password !== 'string' || password.length > 256) return { status: 401, error: t('密码错误') };
      working++;
      try {
        const key = await scrypt(password, record.salt, 64);
        if (!timingSafeEqual(key, Buffer.from(record.hash, 'hex'))) return { status: 401, error: t('密码错误') };
      } finally { working--; }
      attempts.delete(ip);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 8 * 60 * 60_000;
      sessions.set(token, expiresAt);
      return { token, expiresAt };
    },
    valid(token) { prune(); return typeof token === 'string' && sessions.has(token); },
    logout: token => sessions.delete(token),
    close: () => sessions.clear(),
  };
}
