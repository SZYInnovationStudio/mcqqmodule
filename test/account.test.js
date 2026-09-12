import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/account.js';

test('首次设置用户名密码后持久化哈希，且不能重复设置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-account-'));
  try {
    const account = new AccountStore(dir);
    assert.equal(account.configured, false);
    assert.throws(() => account.setup('admin', 'short'), /密码/);
    assert.throws(() => account.setup('admin', 'abcdef'), /字母和数字/);
    assert.throws(() => account.setup('admin', '123456'), /字母和数字/);
    assert.throws(() => account.setup('admin', 'abc12!'), /字母和数字/);
    account.setup('server_admin', 'abc123');
    assert.equal(account.configured, true);
    assert.equal(account.verify('server_admin', 'abc123'), true);
    assert.equal(account.verify('other', 'abc123'), false);
    assert.equal(account.verify('server_admin', 'wrong-password'), false);
    assert.ok(!readFileSync(join(dir, 'admin.json'), 'utf8').includes('abc123'));
    assert.equal(new AccountStore(dir).verify('server_admin', 'abc123'), true);
    assert.throws(() => account.setup('other', 'another123'), /已经设置/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('修改用户名和密码时必须提供当前密码，旧凭据失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcqq-account-'));
  try {
    const account = new AccountStore(dir);
    account.setup('admin', 'initial123');
    assert.throws(() => account.change('wrong', 'new_admin', 'next456'), /当前密码/);
    account.change('initial123', 'new_admin', 'next456');
    assert.equal(account.verify('admin', 'initial123'), false);
    assert.equal(account.verify('new_admin', 'next456'), true);
    account.change('next456', 'final_admin', '');
    assert.equal(new AccountStore(dir).verify('final_admin', 'next456'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
