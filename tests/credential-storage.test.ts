import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUserService } from '../src/services/userService.ts';
import { createTestDirectory } from './helpers/test-helper.ts';

it('resets only the selected password through the stopped-server CLI', async () => {
  const dir = await createTestDirectory('credentials', 'offline reset');
  const file = join(dir, 'accounts.json');
  const accounts = ['alice', 'bob'].map((username, index) => ({
    username,
    id: String(index),
    salt: 'fixture',
    passwordHash: 'legacy',
    role: index === 0 ? 'admin' : 'read',
    createdAt: '',
    updatedAt: '',
    authVersion: 4,
    totp: {
      encryptedSecret: 'offline',
      recoveryCodeHashes: [],
      lastUsedStep: 1,
      enabledAt: '',
    },
  }));
  await writeFile(file, JSON.stringify(accounts));
  const args = [
    resolve('dist/cli.mjs'),
    '--users-file',
    file,
    '--password-reset',
    'alice',
  ];
  const pass = 'Registration-Sapphire-73-Tree!';
  const run = (input: string) =>
    spawnSync(process.execPath, args, {
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
  const mismatch = run(pass + '\nother\n');
  expect(mismatch.status).toBe(1);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(accounts);
  const result = run(pass + '\n' + pass + '\n');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(pass);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  expect(stored[0]).toMatchObject({
    id: '0',
    role: 'admin',
    totp: accounts[0]!.totp,
    authVersion: 5,
  });
  expect(stored[0].passwordHash).toMatch(/^scrypt\$/);
  expect(stored[1]).toEqual(accounts[1]);
});

it('separates human passwords from random bearer tokens and rejects obsolete credentials', async () => {
  const dir = await createTestDirectory('credentials', 'formats');
  const file = join(dir, 'users.json');
  const users = createUserService({
    configDir: dir,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serverConfig: { port: 0, passwordStrengthCheck: false },
  });
  try {
    await users.initialize();
    const password = 'example-password';
    const alice = await users.createUser({
      username: 'alice',
      password,
      role: 'admin',
    });
    const bob = await users.createUser({
      username: 'bob',
      password,
      role: 'read',
    });
    expect(alice.passwordHash).toMatch(/^scrypt\$/);
    expect(bob.passwordHash).not.toBe(alice.passwordHash);
    const token = (await users.addNpmToken('alice', 'fixture'))!;
    expect((await users.getUser('alice'))!.npmTokens![0]!.tokenHash).toMatch(
      /^sha256\$/
    );
    expect((await users.validateNpmToken(token.token))?.id).toBe(alice.id);
    expect(await users.validateNpmToken(password)).toBeUndefined();
    expect(
      await users.validateCredentials('alice', token.token)
    ).toBeUndefined();
    const records = JSON.parse(await readFile(file, 'utf8'));
    // Representative legacy SHA-1 records have a 20-byte Base64 digest.
    records[0].passwordHash = Buffer.alloc(20).toString('base64');
    records[0].npmTokens[0].tokenHash = Buffer.alloc(20).toString('base64');
    await writeFile(file, JSON.stringify(records));
    users.destroy();
    await users.initialize();
    expect(await users.validateCredentials('alice', password)).toBeUndefined();
    expect(await users.validateNpmToken(token.token)).toBeUndefined();
    await users.updateUser('alice', { password: 'new-example-password' });
    expect(
      (await users.validateCredentials('alice', 'new-example-password'))?.id
    ).toBe(alice.id);
    expect((await users.validateCredentials('bob', password))?.role).toBe(
      'read'
    );
  } finally {
    users.destroy();
  }
});
