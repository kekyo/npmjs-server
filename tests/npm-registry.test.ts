import { afterEach, describe, expect, test, vi } from 'vitest';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { createFileItem, createTarPacker } from 'tar-vern';
import { createReaderWriterLock } from 'async-primitives';
import {
  createFastifyInstance,
  startFastifyServer,
  FastifyServerInstance,
} from '../src/server.ts';
import { createConsoleLogger } from '../src/logger';
import { ServerConfig } from '../src/types';
import { createUserService } from '../src/services/userService';
import { createMetadataService } from '../src/services/metadataService.ts';
import { createPackageEntryFromTarball } from '../src/services/npmPublishService.ts';
import { calculateDist } from '../src/utils/npmPackage.ts';
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

  test('rejects an archive whose storage name disagrees with its validated package identity', async ({
    task,
  }) => {
    const dir = await createTestDirectory('npm-registry', task.name);
    const storage = createMetadataService(
      dir,
      'http://localhost',
      silentLogger
    );
    await storage.initialize();
    const bytes = await createPackageTarball({
      name: 'demo',
      version: '1.0.0',
    });
    const entry = await createPackageEntryFromTarball(
      bytes,
      'http://localhost'
    );
    entry.storage.tarballName = 'another-archive.tgz';
    await expect(storage.addPackageEntry(entry, bytes)).rejects.toThrow(
      /storage identity/
    );
    expect(storage.getPackageMetadata('demo')).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('serves icons only for registered packages and keeps linked files within the registry', async (context) => {
    const configDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const packageDir = path.join(configDir, 'packages');
    await fs.mkdir(packageDir);
    const app = await createFastifyInstance(
      { port: 0, configDir, packageDir },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;
    const tarball = await createPackageTarball({
      name: '@demo/Icons',
      version: '1.0.0-RC.1',
    });
    const published = await app.inject({
      method: 'POST',
      url: '/api/publish',
      headers: { 'content-type': 'application/octet-stream' },
      payload: tarball,
    });
    expect(published.statusCode).toBe(201);
    const directory = path.join(packageDir, '@demo', 'Icons', '1.0.0-RC.1');
    const icon = path.join(directory, 'icon.png');
    await fs.writeFile(icon, 'registered icon');
    expect(
      (await app.inject('/api/ui/icon/%40demo%2FIcons/1.0.0-RC.1')).body
    ).toBe('registered icon');
    expect((await app.inject('/api/ui/icon/%40demo%2FIcons/0.9.0')).body).toBe(
      'registered icon'
    );
    await fs.mkdir(path.join(packageDir, 'unpublished', '1.0.0'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(packageDir, 'unpublished', '1.0.0', 'icon.png'),
      'unregistered'
    );
    expect(
      (await app.inject('/api/ui/icon/unpublished/1.0.0')).statusCode
    ).toBe(404);
    await fs.unlink(icon);
    const outside = path.join(configDir, 'sample-image');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, icon);
    expect(
      (await app.inject('/api/ui/icon/%40demo%2FIcons/1.0.0-RC.1')).statusCode
    ).toBe(404);
  });

  test('refuses a linked package directory on publish without changing its target', async ({
    task,
  }) => {
    const dir = await createTestDirectory('npm-registry', task.name);
    const packages = path.join(dir, 'packages');
    const sibling = path.join(dir, 'sibling');
    await fs.mkdir(packages);
    await fs.mkdir(sibling);
    await fs.symlink(sibling, path.join(packages, 'sample'), 'dir');
    const app = await createFastifyInstance(
      { port: 0, configDir: dir, packageDir: packages },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;
    const payload = await createPackageTarball({
      name: 'sample',
      version: '1.0.0',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/publish',
      headers: { 'content-type': 'application/octet-stream' },
      payload,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await fs.readdir(sibling)).toEqual([]);
  });

  test('should reject invalid versions before either publish API writes package files', async (context) => {
    const configDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const packageDir = path.join(configDir, 'packages');
    await fs.mkdir(packageDir);
    const app = await createFastifyInstance(
      { port: 0, configDir, packageDir, authMode: 'none' },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;

    const manifest = { name: 'example', version: '1.0.0 ' };
    const tarball = await createPackageTarball(manifest);
    const npm = await app.inject({
      method: 'PUT',
      url: '/example',
      payload: createPublishDocument(manifest, tarball),
    });
    const ui = await app.inject({
      method: 'POST',
      url: '/api/publish',
      headers: { 'content-type': 'application/octet-stream' },
      payload: tarball,
    });
    expect([npm.statusCode, ui.statusCode]).toEqual([400, 400]);
    expect(await fs.readdir(packageDir)).toEqual([]);
  });

  test.each(['error', 'ignore'] as const)(
    'should serve the accepted archive and metadata after competing publications under %s',
    async (policy) => {
      const configDir = await createTestDirectory(
        'npm-registry',
        `competing-publications-${policy}`
      );
      const packageDir = path.join(configDir, 'packages');
      await fs.mkdir(packageDir);
      const app = await createFastifyInstance(
        { port: 0, configDir, packageDir, duplicatePackagePolicy: policy },
        silentLogger,
        createReaderWriterLock()
      );
      server = app;
      const version = '1.2.3-rc.1+Build.007';
      const manifests = ['first', 'second'].map((description) => ({
        name: 'example',
        version,
        description,
      }));
      const archives = await Promise.all(
        manifests.map((manifest) => createPackageTarball(manifest))
      );
      const responses = await Promise.all(
        archives.map((archive) =>
          app.inject({
            method: 'POST',
            url: '/api/publish',
            headers: { 'content-type': 'application/octet-stream' },
            payload: archive,
          })
        )
      );
      const accepted = responses.findIndex(
        (response) => response.statusCode === 201
      );
      expect(accepted).toBeGreaterThanOrEqual(0);
      expect(responses[1 - accepted]!.statusCode).toBe(
        policy === 'ignore' ? 200 : 409
      );
      const packument = (await app.inject('/example')).json();
      const document = packument.versions[version];
      expect(document.description).toBe(manifests[accepted]!.description);
      const downloadUrl = new URL(document.dist.tarball).pathname;
      expect((await app.inject(downloadUrl)).rawPayload).toEqual(
        archives[accepted]
      );

      const invalid = { name: 'example', version: version + ' ' };
      const bytes = await createPackageTarball(invalid);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/example',
            payload: createPublishDocument(invalid, bytes),
          })
        ).statusCode
      ).toBe(400);
      expect((await app.inject('/example')).json()).toEqual(packument);
      expect((await app.inject(downloadUrl)).rawPayload).toEqual(
        archives[accepted]
      );
    }
  );

  test('should preserve an occupied version directory missing from the metadata index', async (context) => {
    const configDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const packageDir = path.join(configDir, 'packages');
    await fs.mkdir(packageDir);
    const app = await createFastifyInstance(
      { port: 0, configDir, packageDir },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;
    const manifest = { name: 'example', version: '1.0.0' };
    const versionDir = path.join(packageDir, manifest.name, manifest.version);
    await fs.mkdir(versionDir, { recursive: true });
    const archivePath = path.join(versionDir, 'example-1.0.0.tgz');
    const original = await createPackageTarball(manifest, 'original');
    await fs.writeFile(archivePath, original);

    const replacement = await createPackageTarball(manifest, 'replacement');
    const rejected = await app.inject({
      method: 'PUT',
      url: '/example',
      payload: createPublishDocument(manifest, replacement),
    });
    expect(rejected.statusCode).toBe(409);
    expect(await fs.readFile(archivePath)).toEqual(original);
    expect(await fs.readdir(versionDir)).toEqual(['example-1.0.0.tgz']);
  });

  test('should serve valid releases beside invalid stored version metadata after restart', async (context) => {
    const configDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const packageDir = path.join(configDir, 'packages');
    const name = 'example';
    const version = '1.0.0';
    const tarball = await createPackageTarball({ name, version });
    const metadata = JSON.stringify(calculateDist(tarball));
    for (const [directory, recorded] of [
      [version, version],
      ['preview', 'preview'],
      ['2.0.0', '3.0.0'],
    ] as const) {
      const destination = path.join(packageDir, name, directory);
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(
        path.join(destination, 'package.json'),
        JSON.stringify({ name, version: recorded })
      );
      await fs.writeFile(path.join(destination, 'metadata.json'), metadata);
    }
    await fs.writeFile(
      path.join(packageDir, name, version, 'example-1.0.0.tgz'),
      tarball
    );
    const app = await createFastifyInstance(
      { port: 0, configDir, packageDir },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;
    const packument = (await app.inject('/example')).json();
    expect(Object.keys(packument.versions ?? {})).toEqual([version]);
    const url = new URL(packument.versions[version].dist.tarball).pathname;
    expect((await app.inject(url)).rawPayload).toEqual(tarball);
  });

  test('should keep the previous release available if an explicit overwrite fails and allow a retry', async (context) => {
    const configDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const packageDir = path.join(configDir, 'packages');
    await fs.mkdir(packageDir);
    const app = await createFastifyInstance(
      { port: 0, configDir, packageDir, duplicatePackagePolicy: 'overwrite' },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;
    const publish = async (name: string, description: string) => {
      const tarball = await createPackageTarball({
        name,
        version: '1.0.0',
        description,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/publish',
        headers: { 'content-type': 'application/octet-stream' },
        payload: tarball,
      });
      return { tarball, response };
    };
    const original = await publish('example', 'original');
    expect(original.response.statusCode).toBe(201);
    const metadata = (await app.inject('/example')).json();
    const url = new URL(metadata.versions['1.0.0'].dist.tarball).pathname;
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await fs.writeFile(
      path.join(packageDir, 'example', '1.0.0', 'icon.svg'),
      icon
    );
    const tagsPath = path.join(packageDir, 'example', 'dist-tags.json');
    await fs.mkdir(tagsPath);
    expect(
      (await publish('example', 'replacement')).response.statusCode
    ).toBeGreaterThanOrEqual(400);
    expect((await app.inject('/example')).json()).toEqual(metadata);
    expect((await app.inject(url)).rawPayload).toEqual(original.tarball);

    await fs.rmdir(tagsPath);
    const replaced = await publish('example', 'replacement');
    expect(replaced.response.statusCode).toBe(201);
    expect((await app.inject(url)).rawPayload).toEqual(replaced.tarball);
    expect((await app.inject('/example/1.0.0')).json().description).toBe(
      'replacement'
    );
    expect((await app.inject('/api/ui/icon/example/1.0.0')).body).toBe(icon);
    const recased = await publish('Example', 'recased');
    expect(recased.response.statusCode).toBe(201);
    const recasedInfo = (await app.inject('/Example/1.0.0')).json();
    expect(
      (await app.inject(new URL(recasedInfo.dist.tarball).pathname)).rawPayload
    ).toEqual(recased.tarball);
  });

  test.skipIf(process.platform === 'win32')(
    'should preserve registry file permissions during an overwrite',
    async (context) => {
      const configDir = await createTestDirectory(
        'npm-registry',
        context.task.name
      );
      const packageDir = path.join(configDir, 'packages');
      await fs.mkdir(packageDir);
      const app = await createFastifyInstance(
        { port: 0, configDir, packageDir, duplicatePackagePolicy: 'overwrite' },
        silentLogger,
        createReaderWriterLock()
      );
      server = app;
      const manifest = { name: 'example', version: '1.0.0' };
      const tarball = await createPackageTarball(manifest);
      const document = createPublishDocument(manifest, tarball);
      const response = await app.inject({
        method: 'PUT',
        url: '/example',
        payload: {
          ...document,
          'dist-tags': { latest: manifest.version, beta: manifest.version },
        },
      });
      expect(response.statusCode).toBe(201);
      const tags = path.join(packageDir, 'example', 'dist-tags.json');
      const metadata = path.join(
        packageDir,
        'example',
        '1.0.0',
        'metadata.json'
      );
      expect((await fs.stat(tags)).mode & 0o777).toBe(0o666 & ~process.umask());
      await fs.chmod(tags, 0o640);
      await fs.chmod(metadata, 0o600);
      const overwrite = {
        method: 'POST',
        url: '/api/publish',
        headers: { 'content-type': 'application/octet-stream' },
        payload: await createPackageTarball(manifest, 'replacement'),
      } as const;
      expect((await app.inject(overwrite)).statusCode).toBe(201);
      expect((await fs.stat(tags)).mode & 0o777).toBe(0o640);
      expect((await fs.stat(metadata)).mode & 0o777).toBe(0o600);
      if (process.getuid?.() !== 0) {
        await fs.chmod(metadata, 0o400);
        expect((await app.inject(overwrite)).statusCode).toBeGreaterThanOrEqual(
          400
        );
      }
    }
  );

  test('should serve a committed release when staging cleanup fails', async (context) => {
    const configDir = await createTestDirectory(
      'npm-registry',
      context.task.name
    );
    const packageDir = path.join(configDir, 'packages');
    await fs.mkdir(packageDir);
    const app = await createFastifyInstance(
      { port: 0, configDir, packageDir },
      silentLogger,
      createReaderWriterLock()
    );
    server = app;
    const manifest = { name: 'example', version: '1.0.0' };
    const tarball = await createPackageTarball(manifest);
    const rm = fs.rm.bind(fs);
    const cleanup = vi
      .spyOn(fs, 'rm')
      .mockImplementation(async (destination, options) => {
        if (options?.recursive)
          throw Object.assign(new Error('Directory busy'), { code: 'EBUSY' });
        await rm(destination, options);
      });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/example',
        payload: createPublishDocument(manifest, tarball),
      });
      expect(response.statusCode).toBe(201);
      const info = (await app.inject('/example/1.0.0')).json();
      expect(
        (await app.inject(new URL(info.dist.tarball).pathname)).rawPayload
      ).toEqual(tarball);
    } finally {
      cleanup.mockRestore();
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
    expect(await fs.readdir(path.dirname(distTagsPath))).not.toContain(
      'dist-tags.json'
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
    expect(await fs.readdir(path.dirname(distTagsPath))).not.toContain(
      'dist-tags.json'
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
