// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReaderWriterLock } from 'async-primitives';
import { createFastifyInstance } from '../src/server.ts';
import { generateSalt, hashPassword } from '../src/utils/crypto.ts';
import { createTestDirectory } from './helpers/test-helper.ts';

it('reports migration to the account holder and admin while existing npm clients keep working', async () => {
  const configDir = await createTestDirectory(
    'credentials',
    'migration routes'
  );
  const packageDir = join(configDir, 'packages');
  await mkdir(packageDir, { recursive: true });
  const legacy = {
    id: 'alice-id',
    username: 'alice',
    role: 'publish',
    salt: 'legacy-salt',
    passwordHash: 'SOvUmqH2BOLjR7bnt38nsurOooc=',
    createdAt: '2020-01-01',
    updatedAt: '2020-01-01',
  };
  const token = {
    key: 'build-key',
    label: 'build',
    salt: 'legacy-salt',
    tokenHash: 'aTy4FwQS0BXd7NhDZA4YVA/r4mE=',
    createdAt: '2020-01-01',
  };
  const adminSalt = generateSalt();
  const admin = {
    ...legacy,
    id: 'admin-id',
    username: 'owner',
    role: 'admin',
    salt: adminSalt,
    passwordHash: await hashPassword('owner-password', adminSalt),
  };
  await writeFile(
    join(configDir, 'users.json'),
    JSON.stringify([
      admin,
      { ...legacy, npmTokens: [token] },
      { ...legacy, id: 'idle-id', username: 'idle' },
    ])
  );
  const app = await createFastifyInstance(
    {
      configDir,
      packageDir,
      port: 0,
      authMode: 'full',
      passwordStrengthCheck: false,
    },
    { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    createReaderWriterLock()
  );
  const login = async (username: string, password: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    return {
      sessionToken: response.cookies.find(
        (cookie) => cookie.name === 'sessionToken'
      )!.value,
    };
  };
  const list = async (path: string, cookies: { sessionToken: string }) =>
    await app.inject({
      method: 'POST',
      url: '/api/ui/' + path,
      cookies,
      payload: { action: 'list' },
    });
  const whoami = async () =>
    await app.inject({
      url: '/-/whoami',
      headers: { authorization: 'Bearer npmjs_fixture' },
    });
  try {
    expect(
      (await app.inject({ url: '/api/config' })).json().currentUser
    ).toBeNull();
    const owner = await login('owner', 'owner-password');
    const before = (await list('users', owner)).json();
    expect(before.credentialMigration).toEqual({ passwords: 2, npmTokens: 1 });
    expect(before.users[1]).not.toHaveProperty('passwordHash');
    expect(before.users[1]).not.toHaveProperty('npmTokens');

    const npmLogin = await app.inject({
      method: 'PUT',
      url: '/-/user/org.couchdb.user:alice',
      payload: { name: 'alice', password: 'example-password' },
    });
    expect(npmLogin.statusCode).toBe(200);
    expect(npmLogin.json().token).toMatch(/^npmjs_/);
    expect((await list('users', owner)).json().credentialMigration).toEqual({
      passwords: 1,
      npmTokens: 1,
    });

    const alice = await login('alice', 'example-password');
    const session = await app.inject({
      url: '/api/auth/session',
      cookies: alice,
    });
    expect(session.json().user.passwordChangeRecommended).toBe(true);
    for (const method of ['GET', 'POST'] as const) {
      const url = method === 'GET' ? '/api/config' : '/api/ui/config';
      const response = await app.inject({ method, url, cookies: alice });
      expect(response.json().currentUser.passwordChangeRecommended).toBe(true);
    }
    expect((await list('users', alice)).statusCode).toBe(403);
    const tokens = (await list('tokens', alice)).json().npmTokens;
    expect(
      tokens.find((entry: { key: string }) => entry.key === token.key)
    ).toEqual({
      key: token.key,
      label: token.label,
      createdAt: token.createdAt,
      migrationStatus: 'pending',
    });
    expect(
      tokens.filter(
        (entry: { migrationStatus?: string }) => entry.migrationStatus
      )
    ).toHaveLength(1);
    expect((await whoami()).json().username).toBe('alice');
    const used = (await list('tokens', alice))
      .json()
      .npmTokens.find((entry: { key: string }) => entry.key === token.key);
    expect(used.lastUsedAt).toBeTruthy();
    expect(used.migrationStatus).toBe('upgraded');
    expect((await list('users', owner)).json().credentialMigration).toEqual({
      passwords: 1,
      npmTokens: 0,
    });

    const change = await app.inject({
      method: 'POST',
      url: '/api/ui/password',
      cookies: alice,
      payload: {
        currentPassword: 'example-password',
        newPassword: 'replacement-password',
      },
    });
    expect(change.json().success).toBe(true);
    expect(
      (await app.inject({ url: '/api/auth/session', cookies: alice })).json()
        .authenticated
    ).toBe(false);
    const renewed = await login('alice', 'replacement-password');
    expect(
      (await app.inject({ url: '/api/config', cookies: renewed })).json()
        .currentUser
    ).not.toHaveProperty('passwordChangeRecommended');
    expect((await whoami()).json().username).toBe('alice');
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/ui/tokens',
      cookies: renewed,
      payload: { action: 'delete', key: token.key },
    });
    expect(revoke.json().success).toBe(true);
    expect((await whoami()).statusCode).toBe(401);
  } finally {
    await app.close();
  }
}, 30_000);
