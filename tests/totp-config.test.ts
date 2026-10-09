import { describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { TOTP } from 'otpauth';
import { createUserService } from '../src/services/userService';
import { createTestDirectory, getTestPort } from './helpers/test-helper';

describe('TOTP encryption key configuration', () => {
  it.each(['config', 'environment'] as const)(
    'uses the key path from %s and refuses to start when the key is lost',
    async (source) => {
      const directory = await createTestDirectory('totp-config', source);
      const keys = join(directory, 'keys');
      await mkdir(keys, { recursive: true });
      await mkdir(join(directory, 'packages'), { recursive: true });
      const password = 'ConfigTotpPassword!123';
      const users = createUserService({
        configDir: directory,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        serverConfig: { port: 4873, passwordStrengthCheck: false },
      });
      try {
        await users.initialize();
        await users.createUser({ username: 'alice', password, role: 'admin' });
      } finally {
        users.destroy();
      }
      const port = await getTestPort();
      const configFile = join(directory, 'config.json');
      await writeFile(
        configFile,
        JSON.stringify({
          port,
          packageDir: './packages',
          usersFile: './users.json',
          authMode: 'full',
          totpKeyFile: './keys/from-config.key',
          passwordStrengthCheck: false,
        })
      );
      const keyFile = join(keys, `from-${source}.key`);
      const env = {
        ...process.env,
        NPMJS_SERVER_TOTP_KEY_FILE: source === 'environment' ? keyFile : '',
      };
      const args = [resolve('dist/cli.mjs'), '-c', configFile];
      const child = spawn(process.execPath, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await new Promise<void>((resolveReady, reject) => {
          let output = '';
          child.on('error', reject);
          child.on('exit', () =>
            reject(new Error(`Server stopped: ${output}`))
          );
          child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            if (output.includes('Fastify server listening')) resolveReady();
          });
          child.stderr.on('data', (chunk) => {
            output += chunk.toString();
          });
        });
        const baseUrl = `http://127.0.0.1:${port}`;
        const login = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password }),
        });
        const cookie = login.headers
          .getSetCookie()
          .find((value) => value.startsWith('sessionToken='))!
          .split(';')[0]!;
        const setup = await fetch(`${baseUrl}/api/ui/totp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ action: 'setup', password }),
        });
        expect(setup.status).toBe(200);
        const { secret } = await setup.json();
        const confirmed = await fetch(`${baseUrl}/api/ui/totp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            action: 'confirm',
            code: new TOTP({ secret }).generate(),
          }),
        });
        expect(confirmed.status).toBe(200);
        expect((await stat(keyFile)).size).toBe(32);
        expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
        await expect(stat(join(directory, 'totp.key'))).rejects.toHaveProperty(
          'code',
          'ENOENT'
        );
        if (source === 'environment') {
          await expect(
            stat(join(keys, 'from-config.key'))
          ).rejects.toHaveProperty('code', 'ENOENT');
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }
      }
      await rm(keyFile);
      await expect(
        promisify(execFile)(process.execPath, args, { env })
      ).rejects.toMatchObject({ code: 1 });
    },
    30_000
  );
});
