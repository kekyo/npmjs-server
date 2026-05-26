import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Fastify, { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import { createFileItem, createTarPacker } from 'tar-vern';
import { startFastifyServer, FastifyServerInstance } from '../src/server';
import { createConsoleLogger } from '../src/logger';
import { ServerConfig } from '../src/types';
import { calculateDist, createTarballFileName } from '../src/utils/npmPackage';
import {
  createTestDirectory,
  getTestPort,
  testGlobalLogLevel,
} from './helpers/test-helper';

const execFileAsync = promisify(execFile);

interface MockUpstreamRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface MockUpstreamVersion {
  manifest: Record<string, any>;
  tarball: Buffer;
  distOverride?: Record<string, string>;
  tarballStatus?: number;
}

interface MockUpstreamPackage {
  name: string;
  versions: MockUpstreamVersion[];
  distTags?: Record<string, string>;
}

interface MockUpstreamServer {
  requests: MockUpstreamRequest[];
  close: () => Promise<void>;
}

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
  const tarballName = createTarballFileName(name, version);

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

const createMockUpstreamServer = async (
  port: number,
  packages: MockUpstreamPackage[]
): Promise<MockUpstreamServer> => {
  const requests: MockUpstreamRequest[] = [];
  const fastify: FastifyInstance = Fastify({ logger: false });
  const packageMap = new Map(
    packages.map((pkg) => [pkg.name.toLowerCase(), pkg])
  );
  const baseUrl = `http://localhost:${port}`;

  fastify.get('/*', async (request, reply) => {
    requests.push({
      url: request.url,
      headers: request.headers,
    });

    const pathname = new URL(request.url, baseUrl).pathname;
    const normalizedPath = pathname.replace(/^\//, '');
    const tarballSeparator = normalizedPath.indexOf('/-/');
    const packagePath =
      tarballSeparator >= 0
        ? normalizedPath.slice(0, tarballSeparator)
        : normalizedPath;
    const packageName = decodeURIComponent(packagePath);
    const pkg = packageMap.get(packageName.toLowerCase());
    if (!pkg) {
      return reply.status(404).send({ error: 'not found' });
    }

    if (tarballSeparator >= 0) {
      const tarballName = decodeURIComponent(
        normalizedPath.slice(tarballSeparator + '/-/'.length)
      );
      const version = pkg.versions.find(
        (candidate) =>
          createTarballFileName(
            candidate.manifest.name,
            candidate.manifest.version
          ) === tarballName
      );
      if (!version) {
        return reply.status(404).send({ error: 'tarball not found' });
      }
      if (version.tarballStatus) {
        return reply
          .status(version.tarballStatus)
          .send({ error: 'tarball failed' });
      }
      return reply.type('application/octet-stream').send(version.tarball);
    }

    const versions = Object.fromEntries(
      pkg.versions.map((version) => {
        const name = version.manifest.name as string;
        const manifestVersion = version.manifest.version as string;
        const tarballName = createTarballFileName(name, manifestVersion);
        const dist = calculateDist(version.tarball);
        return [
          manifestVersion,
          {
            ...version.manifest,
            dist: {
              tarball: `${baseUrl}/${encodeURIComponent(name)}/-/${encodeURIComponent(
                tarballName
              )}`,
              shasum: dist.shasum,
              integrity: dist.integrity,
              ...version.distOverride,
            },
          },
        ];
      })
    );
    const versionNames = Object.keys(versions).sort();
    return reply.send({
      _id: pkg.name,
      name: pkg.name,
      'dist-tags': pkg.distTags ?? {
        latest: versionNames[versionNames.length - 1],
      },
      versions,
      time: Object.fromEntries(
        versionNames.map((version, index) => [
          version,
          new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
        ])
      ),
      readme: '# upstream package',
    });
  });

  await fastify.listen({ port, host: '0.0.0.0' });

  return {
    requests,
    close: async () => {
      await fastify.close();
    },
  };
};

const silentLogger = createConsoleLogger('npm-proxy-test', testGlobalLogLevel);

describe('npm proxy cache routes', () => {
  let server: FastifyServerInstance | undefined;
  let upstream: MockUpstreamServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    if (upstream) {
      await upstream.close();
      upstream = undefined;
    }
  });

  test('should keep proxy disabled unless explicitly enabled', async (context) => {
    const testDir = await createTestDirectory('npm-proxy', context.task.name);
    const port = await getTestPort(15000);
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

    const response = await fetch(`http://localhost:${port}/missing-proxy-pkg`);
    expect(response.status).toBe(404);
  });

  test('should proxy and cache uncached package tarballs without exposing them in search or UI', async (context) => {
    const testDir = await createTestDirectory('npm-proxy', context.task.name);
    const upstreamPort = await getTestPort(16000);
    const port = await getTestPort(17000);
    const tarball = await createPackageTarball({
      name: 'proxied-pkg',
      version: '1.0.0',
      description: 'remote package',
    });
    upstream = await createMockUpstreamServer(upstreamPort, [
      {
        name: 'proxied-pkg',
        versions: [
          {
            manifest: {
              name: 'proxied-pkg',
              version: '1.0.0',
              description: 'remote package',
            },
            tarball,
          },
        ],
      },
    ]);

    const config: ServerConfig = {
      port,
      packageDir: path.join(testDir, 'packages'),
      configDir: testDir,
      authMode: 'none',
      logLevel: testGlobalLogLevel,
      passwordStrengthCheck: false,
      proxy: {
        enabled: true,
        upstreamRegistry: `http://localhost:${upstreamPort}`,
      },
    };
    await fs.mkdir(config.packageDir!, { recursive: true });
    server = await startFastifyServer(config, silentLogger);
    const registry = `http://localhost:${port}`;

    const packumentResponse = await fetch(`${registry}/proxied-pkg`, {
      headers: {
        Authorization: 'Bearer local-token',
        Cookie: 'sessionToken=local-cookie',
      },
    });
    expect(packumentResponse.status).toBe(200);
    const packument = await packumentResponse.json();
    expect(packument.versions['1.0.0'].dist.tarball).toBe(
      `${registry}/proxied-pkg/-/proxied-pkg-1.0.0.tgz`
    );

    const tarballResponse = await fetch(
      packument.versions['1.0.0'].dist.tarball
    );
    expect(tarballResponse.status).toBe(200);
    expect(Buffer.from(await tarballResponse.arrayBuffer())).toEqual(tarball);

    const proxyPackageDir = path.join(testDir, 'proxy-packages');
    await fs.access(
      path.join(proxyPackageDir, 'proxied-pkg', '1.0.0', 'package.json')
    );
    await fs.access(
      path.join(proxyPackageDir, 'proxied-pkg', '1.0.0', 'metadata.json')
    );
    await fs.access(
      path.join(
        proxyPackageDir,
        'proxied-pkg',
        '1.0.0',
        'proxied-pkg-1.0.0.tgz'
      )
    );
    await expect(
      fs.access(path.join(config.packageDir!, 'proxied-pkg'))
    ).rejects.toHaveProperty('code', 'ENOENT');

    const searchResponse = await fetch(
      `${registry}/-/v1/search?text=proxied-pkg`
    );
    const search = await searchResponse.json();
    expect(search.total).toBe(0);

    const uiResponse = await fetch(`${registry}/api/ui/packages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: 'proxied-pkg' }),
    });
    const uiPackages = await uiResponse.json();
    expect(uiPackages.totalHits).toBe(0);

    expect(
      upstream.requests.every(
        (request) =>
          request.headers.authorization === undefined &&
          request.headers.cookie === undefined
      )
    ).toBe(true);

    const consumerDir = path.join(testDir, 'consumer');
    await fs.mkdir(consumerDir, { recursive: true });
    await execFileAsync('npm', ['init', '-y'], { cwd: consumerDir });
    await execFileAsync(
      'npm',
      [
        'install',
        'proxied-pkg@1.0.0',
        '--registry',
        registry,
        '--ignore-scripts',
      ],
      { cwd: consumerDir }
    );
    await fs.access(
      path.join(consumerDir, 'node_modules', 'proxied-pkg', 'package.json')
    );
  }, 120000);

  test('should merge local priority with upstream versions and reuse cached packages offline', async (context) => {
    const testDir = await createTestDirectory('npm-proxy', context.task.name);
    const upstreamPort = await getTestPort(18000);
    const port = await getTestPort(19000);
    const localTarball = await createPackageTarball({
      name: 'shared-pkg',
      version: '1.0.0',
      description: 'local package',
    });
    const upstreamSharedOne = await createPackageTarball({
      name: 'shared-pkg',
      version: '1.0.0',
      description: 'upstream package',
    });
    const upstreamSharedTwo = await createPackageTarball({
      name: 'shared-pkg',
      version: '2.0.0',
      description: 'upstream package',
    });
    const scopedTarball = await createPackageTarball({
      name: '@remote/scoped',
      version: '1.0.0',
      description: 'scoped upstream package',
    });
    upstream = await createMockUpstreamServer(upstreamPort, [
      {
        name: 'shared-pkg',
        versions: [
          {
            manifest: {
              name: 'shared-pkg',
              version: '1.0.0',
              description: 'upstream package',
            },
            tarball: upstreamSharedOne,
          },
          {
            manifest: {
              name: 'shared-pkg',
              version: '2.0.0',
              description: 'upstream package',
            },
            tarball: upstreamSharedTwo,
          },
        ],
        distTags: { latest: '2.0.0' },
      },
      {
        name: '@remote/scoped',
        versions: [
          {
            manifest: {
              name: '@remote/scoped',
              version: '1.0.0',
              description: 'scoped upstream package',
            },
            tarball: scopedTarball,
          },
        ],
      },
    ]);

    const config: ServerConfig = {
      port,
      packageDir: path.join(testDir, 'packages'),
      configDir: testDir,
      authMode: 'none',
      logLevel: testGlobalLogLevel,
      passwordStrengthCheck: false,
      proxy: {
        enabled: true,
        upstreamRegistry: `http://localhost:${upstreamPort}`,
      },
    };
    await fs.mkdir(config.packageDir!, { recursive: true });
    server = await startFastifyServer(config, silentLogger);
    const registry = `http://localhost:${port}`;

    const publishResponse = await fetch(`${registry}/shared-pkg`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        createPublishDocument(
          {
            name: 'shared-pkg',
            version: '1.0.0',
            description: 'local package',
          },
          localTarball
        )
      ),
    });
    expect(publishResponse.status).toBe(201);

    const packumentResponse = await fetch(`${registry}/shared-pkg`);
    expect(packumentResponse.status).toBe(200);
    const packument = await packumentResponse.json();
    expect(Object.keys(packument.versions).sort()).toEqual(['1.0.0', '2.0.0']);
    expect(packument.versions['1.0.0'].description).toBe('local package');
    expect(packument['dist-tags'].latest).toBe('1.0.0');

    const remoteTarballResponse = await fetch(
      packument.versions['2.0.0'].dist.tarball
    );
    expect(remoteTarballResponse.status).toBe(200);
    expect(Buffer.from(await remoteTarballResponse.arrayBuffer())).toEqual(
      upstreamSharedTwo
    );

    const scopedConsumerDir = path.join(testDir, 'scoped-consumer');
    await fs.mkdir(scopedConsumerDir, { recursive: true });
    await execFileAsync('npm', ['init', '-y'], { cwd: scopedConsumerDir });
    await execFileAsync(
      'npm',
      [
        'install',
        '@remote/scoped@1.0.0',
        '--registry',
        registry,
        '--ignore-scripts',
      ],
      { cwd: scopedConsumerDir }
    );
    await fs.access(
      path.join(
        scopedConsumerDir,
        'node_modules',
        '@remote',
        'scoped',
        'package.json'
      )
    );

    await upstream.close();
    upstream = undefined;

    const offlinePackumentResponse = await fetch(`${registry}/shared-pkg`);
    expect(offlinePackumentResponse.status).toBe(200);
    const offlinePackument = await offlinePackumentResponse.json();
    expect(Object.keys(offlinePackument.versions).sort()).toEqual([
      '1.0.0',
      '2.0.0',
    ]);

    const offlineTarballResponse = await fetch(
      offlinePackument.versions['2.0.0'].dist.tarball
    );
    expect(offlineTarballResponse.status).toBe(200);
    expect(Buffer.from(await offlineTarballResponse.arrayBuffer())).toEqual(
      upstreamSharedTwo
    );

    const missingOfflineResponse = await fetch(`${registry}/offline-missing`);
    expect([502, 504]).toContain(missingOfflineResponse.status);
  }, 120000);

  test('should avoid cache artifacts when upstream tarball download or validation fails', async (context) => {
    const testDir = await createTestDirectory('npm-proxy', context.task.name);
    const upstreamPort = await getTestPort(20000);
    const port = await getTestPort(21000);
    const badIntegrityTarball = await createPackageTarball({
      name: 'bad-integrity',
      version: '1.0.0',
    });
    const badNameTarball = await createPackageTarball({
      name: 'other-name',
      version: '1.0.0',
    });
    const brokenDownloadTarball = await createPackageTarball({
      name: 'broken-download',
      version: '1.0.0',
    });
    upstream = await createMockUpstreamServer(upstreamPort, [
      {
        name: 'bad-integrity',
        versions: [
          {
            manifest: {
              name: 'bad-integrity',
              version: '1.0.0',
            },
            tarball: badIntegrityTarball,
            distOverride: { integrity: 'sha512-invalid' },
          },
        ],
      },
      {
        name: 'bad-name',
        versions: [
          {
            manifest: {
              name: 'bad-name',
              version: '1.0.0',
            },
            tarball: badNameTarball,
          },
        ],
      },
      {
        name: 'broken-download',
        versions: [
          {
            manifest: {
              name: 'broken-download',
              version: '1.0.0',
            },
            tarball: brokenDownloadTarball,
            tarballStatus: 500,
          },
        ],
      },
    ]);

    const config: ServerConfig = {
      port,
      packageDir: path.join(testDir, 'packages'),
      configDir: testDir,
      authMode: 'none',
      logLevel: testGlobalLogLevel,
      passwordStrengthCheck: false,
      proxy: {
        enabled: true,
        upstreamRegistry: `http://localhost:${upstreamPort}`,
      },
    };
    await fs.mkdir(config.packageDir!, { recursive: true });
    server = await startFastifyServer(config, silentLogger);
    const registry = `http://localhost:${port}`;
    const proxyPackageDir = path.join(testDir, 'proxy-packages');

    for (const packageName of [
      'bad-integrity',
      'bad-name',
      'broken-download',
    ]) {
      const packumentResponse = await fetch(`${registry}/${packageName}`);
      expect(packumentResponse.status).toBe(200);
      const packument = await packumentResponse.json();
      const tarballResponse = await fetch(
        packument.versions['1.0.0'].dist.tarball
      );
      expect(tarballResponse.status).toBe(502);
      await expect(
        fs.access(path.join(proxyPackageDir, packageName))
      ).rejects.toHaveProperty('code', 'ENOENT');
    }
  });
});
