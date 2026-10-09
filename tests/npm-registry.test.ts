import { afterEach, describe, expect, test } from 'vitest';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { createFileItem, createTarPacker } from 'tar-vern';
import { startFastifyServer, FastifyServerInstance } from '../src/server';
import { createConsoleLogger } from '../src/logger';
import { ServerConfig } from '../src/types';
import { createUserService } from '../src/services/userService';
import {
  createTestDirectory,
  getTestPort,
  testGlobalLogLevel,
} from './helpers/test-helper';

const execFileAsync = promisify(execFile);

const spawnWithPromptResponses = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    responses: Array<{ prompt: string; input: string }>;
  }
): Promise<{ stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let output = '';
    let responseIndex = 0;
    const handleOutput = (chunk: Buffer) => {
      output += chunk.toString('utf-8');
      while (
        responseIndex < options.responses.length &&
        output.includes(options.responses[responseIndex]!.prompt)
      ) {
        child.stdin.write(options.responses[responseIndex]!.input);
        responseIndex += 1;
      }
    };
    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      stdout.push(buffer);
      handleOutput(buffer);
    });
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      stderr.push(buffer);
      handleOutput(buffer);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      };
      if (code === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed with code ${code}\n${result.stdout}\n${result.stderr}`
          )
        );
      }
    });
  });

const streamToBuffer = async (
  stream: NodeJS.ReadableStream
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const createPackageTarball = async (
  manifest: Record<string, unknown>,
  readme = '# Test package'
): Promise<Buffer> => {
  const items = async function* () {
    yield await createFileItem(
      'package/package.json',
      JSON.stringify(manifest, null, 2)
    );
    yield await createFileItem('package/README.md', readme);
  };
  return streamToBuffer(createTarPacker(items(), 'gzip'));
};

const createPublishDocument = (
  manifest: Record<string, any>,
  tarball: Buffer
) => {
  const name = manifest.name as string;
  const version = manifest.version as string;
  const tarballName = name.startsWith('@')
    ? `${name.split('/')[1]}-${version}.tgz`
    : `${name}-${version}.tgz`;

  return {
    _id: name,
    name,
    'dist-tags': {
      latest: version,
    },
    versions: {
      [version]: manifest,
    },
    _attachments: {
      [tarballName]: {
        content_type: 'application/octet-stream',
        data: tarball.toString('base64'),
        length: tarball.length,
      },
    },
  };
};

const silentLogger = createConsoleLogger(
  'npm-registry-test',
  testGlobalLogLevel
);

describe('npm registry routes', () => {
  let server: FastifyServerInstance | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  test('should publish, read, download, and tag a scoped package over HTTP', async (context) => {
    const testDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const port = await getTestPort(12000);
    const config: ServerConfig = {
      port,
      packageDir: path.join(testDir, 'packages'),
      configDir: testDir,
      authMode: 'none',
      logLevel: testGlobalLogLevel,
      passwordStrengthCheck: false,
    };
    await fs.mkdir(config.packageDir!, { recursive: true });
    server = await startFastifyServer(config, silentLogger);

    const manifest = {
      name: '@scope/pkg',
      version: '1.0.0',
      description: 'scoped package',
      keywords: ['scoped', 'test'],
    };
    const tarball = await createPackageTarball(manifest);
    const distTagsPath = path.join(
      config.packageDir!,
      '@scope',
      'pkg',
      'dist-tags.json'
    );
    const publishResponse = await fetch(
      `http://localhost:${port}/${encodeURIComponent('@scope/pkg')}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPublishDocument(manifest, tarball)),
      }
    );
    expect(publishResponse.status).toBe(201);
    await expect(fs.access(distTagsPath)).rejects.toHaveProperty(
      'code',
      'ENOENT'
    );

    const duplicateResponse = await fetch(
      `http://localhost:${port}/${encodeURIComponent('@scope/pkg')}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createPublishDocument(manifest, tarball)),
      }
    );
    expect(duplicateResponse.status).toBe(409);

    const packumentResponse = await fetch(
      `http://localhost:${port}/${encodeURIComponent('@scope/pkg')}`
    );
    expect(packumentResponse.status).toBe(200);
    const packument = await packumentResponse.json();
    expect(packument.name).toBe('@scope/pkg');
    expect(packument['dist-tags'].latest).toBe('1.0.0');
    expect(packument.versions['1.0.0'].dist.integrity).toMatch(/^sha512-/);

    const tarballResponse = await fetch(
      packument.versions['1.0.0'].dist.tarball
    );
    expect(tarballResponse.status).toBe(200);
    expect(Buffer.byteLength(await tarballResponse.arrayBuffer())).toBe(
      tarball.length
    );

    const tagResponse = await fetch(
      `http://localhost:${port}/-/package/${encodeURIComponent('@scope/pkg')}/dist-tags/beta`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('1.0.0'),
      }
    );
    expect(tagResponse.status).toBe(200);
    expect(JSON.parse(await fs.readFile(distTagsPath, 'utf-8'))).toEqual({
      beta: '1.0.0',
    });

    const tagsResponse = await fetch(
      `http://localhost:${port}/-/package/${encodeURIComponent('@scope/pkg')}/dist-tags`
    );
    expect(await tagsResponse.json()).toEqual({
      latest: '1.0.0',
      beta: '1.0.0',
    });

    await server.close();
    server = undefined;
    server = await startFastifyServer(config, silentLogger);

    const reloadedTagsResponse = await fetch(
      `http://localhost:${port}/-/package/${encodeURIComponent('@scope/pkg')}/dist-tags`
    );
    expect(await reloadedTagsResponse.json()).toEqual({
      latest: '1.0.0',
      beta: '1.0.0',
    });

    const deleteTagResponse = await fetch(
      `http://localhost:${port}/-/package/${encodeURIComponent('@scope/pkg')}/dist-tags/beta`,
      {
        method: 'DELETE',
      }
    );
    expect(deleteTagResponse.status).toBe(200);
    await expect(fs.access(distTagsPath)).rejects.toHaveProperty(
      'code',
      'ENOENT'
    );

    const tagsAfterDeleteResponse = await fetch(
      `http://localhost:${port}/-/package/${encodeURIComponent('@scope/pkg')}/dist-tags`
    );
    expect(await tagsAfterDeleteResponse.json()).toEqual({
      latest: '1.0.0',
    });

    const consumerDir = path.join(testDir, 'consumer');
    await fs.mkdir(consumerDir, { recursive: true });
    await execFileAsync('npm', ['init', '-y'], { cwd: consumerDir });
    await execFileAsync(
      'npm',
      ['install', '@scope/pkg@1.0.0', '--registry', `http://localhost:${port}`],
      { cwd: consumerDir }
    );
    await fs.access(
      path.join(consumerDir, 'node_modules', '@scope', 'pkg', 'package.json')
    );
  });

  test('should issue legacy login tokens and authorize publish', async (context) => {
    const testDir = await createTestDirectory(
      'npm-registry-auth',
      context.task.name
    );
    const port = await getTestPort(13000);
    const packageDir = path.join(testDir, 'packages');
    await fs.mkdir(packageDir, { recursive: true });

    const userService = createUserService({
      configDir: testDir,
      logger: silentLogger,
      serverConfig: {
        port,
        passwordStrengthCheck: false,
      },
    });
    await userService.initialize();
    await userService.createUser({
      username: 'publisher',
      password: 'publisher-pass',
      role: 'publish',
    });
    userService.destroy();

    server = await startFastifyServer(
      {
        port,
        packageDir,
        configDir: testDir,
        authMode: 'publish',
        logLevel: testGlobalLogLevel,
        passwordStrengthCheck: false,
      },
      silentLogger
    );

    const loginResponse = await fetch(
      `http://localhost:${port}/-/user/org.couchdb.user:publisher`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'publisher',
          password: 'publisher-pass',
        }),
      }
    );
    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json();
    expect(login.token).toMatch(/^npmjs_/);

    const whoamiResponse = await fetch(`http://localhost:${port}/-/whoami`, {
      headers: { Authorization: `Bearer ${login.token}` },
    });
    expect(await whoamiResponse.json()).toEqual({ username: 'publisher' });

    const registry = `http://localhost:${port}`;
    const npmHomeDir = path.join(testDir, 'npm-home');
    const npmUserConfig = path.join(testDir, 'npmrc');
    await fs.mkdir(npmHomeDir, { recursive: true });
    const npmLoginEnv = {
      ...process.env,
      HOME: npmHomeDir,
      NPM_CONFIG_USERCONFIG: npmUserConfig,
    };
    await spawnWithPromptResponses(
      'script',
      [
        '-qec',
        `npm login --auth-type=legacy --registry ${registry}`,
        '/dev/null',
      ],
      {
        cwd: testDir,
        env: npmLoginEnv,
        responses: [
          { prompt: 'Username:', input: 'publisher\n' },
          { prompt: 'Password:', input: 'publisher-pass\n' },
          { prompt: 'Email:', input: 'publisher@example.test\n' },
        ],
      }
    );
    const cliWhoami = await execFileAsync(
      'npm',
      ['whoami', '--registry', registry],
      { cwd: testDir, env: npmLoginEnv }
    );
    expect(cliWhoami.stdout.trim()).toBe('publisher');

    const manifest = {
      name: 'private-pkg',
      version: '1.0.0',
      description: 'published with token',
    };
    const tarball = await createPackageTarball(manifest);
    const publishResponse = await fetch(
      `http://localhost:${port}/private-pkg`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${login.token}`,
        },
        body: JSON.stringify(createPublishDocument(manifest, tarball)),
      }
    );
    expect(publishResponse.status).toBe(201);
  });

  test('should enforce full auth mode roles and revoke tokens from UI API', async (context) => {
    const testDir = await createTestDirectory(
      'npm-registry-full-auth',
      context.task.name
    );
    const port = await getTestPort(13500);
    const packageDir = path.join(testDir, 'packages');
    await fs.mkdir(packageDir, { recursive: true });

    const userService = createUserService({
      configDir: testDir,
      logger: silentLogger,
      serverConfig: {
        port,
        passwordStrengthCheck: false,
      },
    });
    await userService.initialize();
    await userService.createUser({
      username: 'reader',
      password: 'reader-pass',
      role: 'read',
    });
    await userService.createUser({
      username: 'publisher',
      password: 'publisher-pass',
      role: 'publish',
    });
    const readToken = await userService.addNpmToken('reader', 'read token');
    const publishToken = await userService.addNpmToken(
      'publisher',
      'publish token'
    );
    if (!readToken || !publishToken) {
      throw new Error('Failed to create npm tokens');
    }
    userService.destroy();

    server = await startFastifyServer(
      {
        port,
        packageDir,
        configDir: testDir,
        authMode: 'full',
        logLevel: testGlobalLogLevel,
        passwordStrengthCheck: false,
      },
      silentLogger
    );

    const registry = `http://localhost:${port}`;
    const manifest = {
      name: 'auth-pkg',
      version: '1.0.0',
      description: 'auth package',
    };
    const tarball = await createPackageTarball(manifest);
    const publishBody = JSON.stringify(
      createPublishDocument(manifest, tarball)
    );

    const anonymousReadResponse = await fetch(`${registry}/auth-pkg`);
    expect(anonymousReadResponse.status).toBe(401);

    const readPublishResponse = await fetch(`${registry}/auth-pkg`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readToken.token}`,
      },
      body: publishBody,
    });
    expect(readPublishResponse.status).toBe(403);

    const publishResponse = await fetch(`${registry}/auth-pkg`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${publishToken.token}`,
      },
      body: publishBody,
    });
    expect(publishResponse.status).toBe(201);

    const readResponse = await fetch(`${registry}/auth-pkg`, {
      headers: { Authorization: `Bearer ${readToken.token}` },
    });
    expect(readResponse.status).toBe(200);

    const readTagResponse = await fetch(
      `${registry}/-/package/auth-pkg/dist-tags/beta`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${readToken.token}`,
        },
        body: JSON.stringify('1.0.0'),
      }
    );
    expect(readTagResponse.status).toBe(403);

    const publishTagResponse = await fetch(
      `${registry}/-/package/auth-pkg/dist-tags/beta`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${publishToken.token}`,
        },
        body: JSON.stringify('1.0.0'),
      }
    );
    expect(publishTagResponse.status).toBe(200);

    const loginResponse = await fetch(`${registry}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'publisher',
        password: 'publisher-pass',
      }),
    });
    expect(loginResponse.status).toBe(200);
    const sessionCookie = loginResponse.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('sessionToken='))
      ?.split(';')[0];
    expect(sessionCookie).toBeDefined();

    const tokenListResponse = await fetch(`${registry}/api/ui/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie!,
      },
      body: JSON.stringify({ action: 'list' }),
    });
    expect(tokenListResponse.status).toBe(200);
    const tokenList = await tokenListResponse.json();
    expect(tokenList.npmTokens.map((token: any) => token.key)).toContain(
      publishToken.key
    );

    const revokeResponse = await fetch(`${registry}/api/ui/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie!,
      },
      body: JSON.stringify({ action: 'delete', key: publishToken.key }),
    });
    expect(revokeResponse.status).toBe(200);

    const revokedWhoamiResponse = await fetch(`${registry}/-/whoami`, {
      headers: { Authorization: `Bearer ${publishToken.token}` },
    });
    expect(revokedWhoamiResponse.status).toBe(401);
  });

  test('should be compatible with npm publish, view, and install for unscoped packages', async (context) => {
    const testDir = await createTestDirectory('npm-cli', context.task.name);
    const port = await getTestPort(14000);
    const packageDir = path.join(testDir, 'packages');
    await fs.mkdir(packageDir, { recursive: true });
    server = await startFastifyServer(
      {
        port,
        packageDir,
        configDir: testDir,
        authMode: 'none',
        logLevel: testGlobalLogLevel,
        passwordStrengthCheck: false,
      },
      silentLogger
    );

    const projectDir = path.join(testDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'cli-pkg',
          version: '1.0.0',
          description: 'npm cli package',
          files: ['index.js'],
        },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(projectDir, 'index.js'),
      'module.exports = 1;\n'
    );

    const registry = `http://localhost:${port}`;
    await execFileAsync(
      'npm',
      [
        'publish',
        '--registry',
        registry,
        `--//localhost:${port}/:_authToken=dummy`,
        '--ignore-scripts',
      ],
      { cwd: projectDir }
    );

    const view = await execFileAsync(
      'npm',
      ['view', 'cli-pkg', 'version', '--registry', registry],
      { cwd: testDir }
    );
    expect(view.stdout.trim()).toBe('1.0.0');

    const whoami = await execFileAsync(
      'npm',
      [
        'whoami',
        '--registry',
        registry,
        `--//localhost:${port}/:_authToken=dummy`,
      ],
      { cwd: testDir }
    );
    expect(whoami.stdout.trim()).toBe('anonymous');

    const search = await execFileAsync(
      'npm',
      ['search', 'cli-pkg', '--registry', registry, '--json'],
      { cwd: testDir }
    );
    expect(search.stdout).toContain('cli-pkg');

    await execFileAsync(
      'npm',
      [
        'dist-tag',
        'add',
        'cli-pkg@1.0.0',
        'beta',
        '--registry',
        registry,
        `--//localhost:${port}/:_authToken=dummy`,
      ],
      { cwd: testDir }
    );
    const tags = await execFileAsync(
      'npm',
      ['dist-tag', 'ls', 'cli-pkg', '--registry', registry],
      { cwd: testDir }
    );
    expect(tags.stdout).toContain('beta: 1.0.0');

    const consumerDir = path.join(testDir, 'consumer');
    await fs.mkdir(consumerDir, { recursive: true });
    await execFileAsync('npm', ['init', '-y'], { cwd: consumerDir });
    await execFileAsync(
      'npm',
      ['install', 'cli-pkg@1.0.0', '--registry', registry, '--ignore-scripts'],
      { cwd: consumerDir }
    );
    await fs.access(
      path.join(consumerDir, 'node_modules', 'cli-pkg', 'index.js')
    );
  }, 120000);
});
