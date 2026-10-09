// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createReaderWriterLock } from 'async-primitives';
import { describe, expect, it, vi } from 'vitest';
import { createFastifyInstance } from '../src/server.ts';

const execFileAsync = promisify(execFile);

describe('Docker HTTP smoke checks', () => {
  it('checks each architecture and npm endpoints through the registry port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'npmjs-server-smoke-'));
    const locker = createReaderWriterLock();
    const server = await createFastifyInstance(
      {
        port: 0,
        configDir: directory,
        packageDir: join(directory, 'packages'),
        authMode: 'none',
        logLevel: 'ignore',
      },
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      locker
    );
    try {
      const address = new URL(
        await server.listen({ host: '127.0.0.1', port: 0 })
      );
      // Use the actual HTTP server; only container management is replaced.
      await writeFile(
        join(directory, 'podman'),
        `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const imageFile = (image) => join(process.env.TEST_IMAGE_DIRECTORY, encodeURIComponent(image));
switch (args[0]) {
  case 'run':
    if (args.includes('--platform') && (args.includes('-d') || args.includes('--entrypoint'))) {
      const platform = args[args.indexOf('--platform') + 1];
      const image = args.includes('--entrypoint') ? args[args.indexOf('--entrypoint') + 2] : args.at(-1);
      // Podman may reuse the first cached architecture for the shared manifest tag.
      const actualPlatform = existsSync(imageFile(image)) ? readFileSync(imageFile(image), 'utf8') : 'linux/amd64';
      assert.equal(actualPlatform, platform, 'The smoke check must run the requested architecture');
    }
    if (args.includes('-d')) {
      assert.equal(args[args.indexOf('-p') + 1], '127.0.0.1::4873');
      console.log('smoke-container');
    }
    break;
  case 'pull':
    console.log('a'.repeat(64));
    break;
  case 'port':
    assert.equal(args.at(-1), '4873/tcp');
    console.log('127.0.0.1:' + process.env.TEST_REGISTRY_PORT);
    break;
  case 'inspect':
    console.log('running');
    break;
  case 'manifest':
    if (args[1] === 'inspect') {
      console.log(JSON.stringify({ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] }));
    }
    break;
  case 'build':
    writeFileSync(imageFile(args[args.indexOf('--tag') + 1]), args[args.indexOf('--platform') + 1]);
    break;
  case 'tag':
  case 'rm':
  case 'logs':
    break;
  default:
    throw new Error('Unexpected Podman command: ' + args.join(' '));
}
`,
        { mode: 0o755 }
      );
      const { stdout } = await execFileAsync(
        'bash',
        [
          resolve('build-docker-multiplatform.sh'),
          '--skip-app-build',
          '--platforms',
          'linux/amd64,linux/arm64',
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
            PUSH_TO_REGISTRY: 'false',
            VERIFY_TARGET_PLATFORMS: 'true',
            VERIFY_HOST_IMAGE: 'true',
            TEST_IMAGE_DIRECTORY: directory,
            TEST_REGISTRY_PORT: address.port,
          },
          timeout: 20_000,
        }
      );
      expect(stdout).toContain('All target platform checks passed');
      expect(stdout).toContain('Host image check passed');
      expect(stdout).toContain('Multi-platform build completed successfully!');
    } finally {
      const lock = await locker.writeLock();
      try {
        await server.close();
      } finally {
        lock.release();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
