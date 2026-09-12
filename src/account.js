import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

function checkUsername(username) {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw new Error('用户名需为 3–32 位字母、数字、下划线、点或短横线');
  }
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 256 || !/^[A-Za-z0-9]+$/.test(password) || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('密码至少 6 位，只能用字母和数字，且必须同时包含两者');
  }
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export class AccountStore {
  constructor(dir) {
    this.path = join(dir, 'admin.json');
    this.account = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
  }

  get configured() { return Boolean(this.account); }
  get username() { return this.account?.username ?? null; }

  verify(username, password) {
    if (!this.account || typeof username !== 'string' || typeof password !== 'string' || password.length > 256) return false;
    const expected = Buffer.from(this.account.hash, 'base64');
    const actual = scryptSync(password, Buffer.from(this.account.salt, 'base64'), expected.length);
    return timingSafeEqual(actual, expected) && username === this.account.username;
  }

  setup(username, password) {
    if (this.account) throw new Error('管理员账户已经设置');
    checkUsername(username);
    checkPassword(password);
    this.write({ username, ...hashPassword(password) });
  }

  change(currentPassword, username, newPassword) {
    if (!this.account || !this.verify(this.account.username, currentPassword)) throw new Error('当前密码错误');
    checkUsername(username);
    if (newPassword) checkPassword(newPassword);
    this.write(newPassword ? { username, ...hashPassword(newPassword) } : { ...this.account, username });
  }

  write(next) {
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.path);
    this.account = next;
  }
}
