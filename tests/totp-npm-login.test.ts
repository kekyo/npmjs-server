import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createReaderWriterLock } from 'async-primitives';
import type { FastifyInstance } from 'fastify';
import { TOTP } from 'otpauth';
import { createFastifyInstance } from '../src/server';
import { createUserService } from '../src/services/userService';
import { createTotpService } from '../src/services/totpService';
import { createTestDirectory } from './helpers/test-helper';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const password = 'NpmTotpPassword!123';
const now = 1_800_000_000_000;

describe('TOTP during npm token issuance', () => {
  let app: FastifyInstance;
  let secret: string;
  let recoveryCodes: string[];

  beforeEach(async ({ task }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    vi.stubEnv('NPMJS_SERVER_AUTH_FAILURE_DELAY_ENABLED', 'false');
    const directory = await createTestDirectory('totp-npm-login', task.name);
    const packageDir = join(directory, 'packages');
    await mkdir(packageDir, { recursive: true });
    const users = createUserService({
      configDir: directory,
      logger,
      serverConfig: { port: 4873, passwordStrengthCheck: false },
    });
    const totp = createTotpService({
      users,
      keyFile: join(directory, 'totp.key'),
      issuer: 'npmjs-server',
    });
    try {
      await users.initialize();
      const user = await users.createUser({
        username: 'alice',
        password,
        role: 'admin',
      });
      const setup = await totp.setup(
        user,
        'setup',
        password,
        '127.0.0.1',
        '',
        false
      );
      secret = setup.secret;
      const confirmed = await totp.confirm(
        'setup',
        new TOTP({ secret }).generate(),
        '127.0.0.1'
      );
      recoveryCodes = confirmed.recoveryCodes;
    } finally {
      totp.destroy();
      users.destroy();
    }
    app = await createFastifyInstance(
      {
        port: 4873,
        configDir: directory,
        packageDir,
        authMode: 'full',
        passwordStrengthCheck: false,
      },
      logger,
      createReaderWriterLock()
    );
    vi.setSystemTime(now + 30_000);
  });

  afterEach(async () => {
    await app?.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('requires npm-otp before issuing a legacy login token and rejects reuse', async () => {
    const request = {
      method: 'PUT' as const,
      url: '/-/user/org.couchdb.user:alice',
      payload: { name: 'alice', password },
    };
    const missing = await app.inject(request);
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('OTP');
    expect(missing.json().token).toBeUndefined();
    const wrong = await app.inject({
      ...request,
      headers: { 'npm-otp': 'invalid' },
    });
    expect(wrong.statusCode).toBe(401);
    const code = new TOTP({ secret }).generate();
    const verified = await app.inject({
      ...request,
      headers: { 'npm-otp': code },
    });
    expect(verified.statusCode).toBe(200);
    const whoami = await app.inject({
      url: '/-/whoami',
      headers: { authorization: `Bearer ${verified.json().token}` },
    });
    expect(whoami.json().username).toBe('alice');
    const reused = await app.inject({
      ...request,
      headers: { 'npm-otp': code },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().token).toBeUndefined();
    const recovered = await app.inject({
      ...request,
      headers: { 'npm-otp': recoveryCodes[0]! },
    });
    expect(recovered.statusCode).toBe(200);
    const reusedRecovery = await app.inject({
      ...request,
      headers: { 'npm-otp': recoveryCodes[0]! },
    });
    expect(reusedRecovery.statusCode).toBe(401);
  });

  it('shares second-factor attempt limits with UI login', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.inject({
        method: 'PUT',
        url: '/-/user/org.couchdb.user:alice',
        payload: { name: 'alice', password },
        headers: { 'npm-otp': 'invalid' },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'PUT',
      url: '/-/user/org.couchdb.user:alice',
      payload: { name: 'alice', password },
      headers: { 'npm-otp': recoveryCodes[0]! },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('600');
    const ui = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password },
    });
    expect(ui.statusCode).toBe(429);
  });

  it.each([false, true])(
    'keeps web login pending until a second factor succeeds (recovery: %s)',
    async (recovery) => {
      const flow = (
        await app.inject({ method: 'POST', url: '/-/v1/login' })
      ).json();
      const url = new URL(flow.loginUrl).pathname;
      const doneUrl = new URL(flow.doneUrl).pathname;
      const login = await app.inject({
        method: 'POST',
        url,
        payload: { username: 'alice', password },
      });
      expect(login.statusCode).toBe(200);
      expect(login.body).toContain('one-time-code');
      expect((await app.inject({ url: doneUrl })).statusCode).toBe(202);
      const wrong = await app.inject({
        method: 'POST',
        url,
        payload: { code: 'invalid' },
      });
      expect(wrong.statusCode).toBe(400);
      expect((await app.inject({ url: doneUrl })).statusCode).toBe(202);
      const verified = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          code: recovery ? recoveryCodes[0]! : new TOTP({ secret }).generate(),
          ...(recovery ? { recovery: 'on' } : {}),
        }).toString(),
      });
      expect(verified.statusCode).toBe(200);
      const done = await app.inject({ url: doneUrl });
      expect(done.statusCode).toBe(200);
      const whoami = await app.inject({
        url: '/-/whoami',
        headers: { authorization: `Bearer ${done.json().token}` },
      });
      expect(whoami.json().username).toBe('alice');
      expect((await app.inject({ url: doneUrl })).statusCode).toBe(404);
    }
  );

  it('expires a pending web login after password changes', async () => {
    const flow = (
      await app.inject({ method: 'POST', url: '/-/v1/login' })
    ).json();
    const url = new URL(flow.loginUrl).pathname;
    await app.inject({
      method: 'POST',
      url,
      payload: { username: 'alice', password },
    });
    const users = (
      app as FastifyInstance & {
        userService: ReturnType<typeof createUserService>;
      }
    ).userService;
    await users.updateUser('alice', { password: 'NewNpmPassword!123' });
    const stale = await app.inject({
      method: 'POST',
      url,
      payload: { code: recoveryCodes[0], recovery: true },
    });
    expect(stale.statusCode).toBe(400);
    expect(
      (await app.inject({ url: new URL(flow.doneUrl).pathname })).statusCode
    ).toBe(202);
  });
});
