import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileItem, createTarPacker } from 'tar-vern';
import {
  createImportService,
  parsePackageNames,
} from '../src/services/importService';
import { createMetadataService } from '../src/services/metadataService';
import { createConsoleLogger } from '../src/logger';
import { createImportHttpClient } from '../src/services/importHttpClient';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFastifyServer } from '../src/server';
import { getTestPort } from './helpers/test-helper';

const logger = createConsoleLogger('import-test', 'ignore');
const tarball = async (name: string, version: string) => {
  const files = [
    await createFileItem(
      'package/package.json',
      JSON.stringify({ name, version })
    ),
    await createFileItem('package/index.js', 'module.exports = 42;'),
  ];
  const chunks: Buffer[] = [];
  for await (const chunk of createTarPacker(
    (async function* () {
      yield* files;
    })(),
    'gzip'
  ))
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

describe('hosted package import', () => {
  let root: string;
  let server: Server;
  let url: string;
  let routes: Map<string, Buffer | object>;
  let requests: Array<{
    path: string;
    authorization: string | undefined;
    accept: string | undefined;
  }>;
  let requiredAuthorization: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-import-test-'));
    routes = new Map();
    requests = [];
    requiredAuthorization = undefined;
    server = createServer((req, res) => {
      requests.push({
        path: req.url!,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
      });
      if (
        requiredAuthorization &&
        req.headers.authorization !== requiredAuthorization
      ) {
        res.writeHead(401).end();
        return;
      }
      const body = routes.get(req.url!);
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader(
        'Content-Type',
        Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'
      );
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hosted/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  const publish = async (
    name: string,
    versions: string[],
    tags: Record<string, string>
  ) => {
    const documents: Record<string, object> = {};
    const time: Record<string, string> = {};
    for (const version of versions) {
      const bytes = await tarball(name, version);
      const pathname = `/hosted/${encodeURIComponent(name)}/${version}.tgz`;
      routes.set(pathname, bytes);
      documents[version] = {
        name,
        version,
        dependencies: { external: '^1.0.0' },
        deprecated: 'Use the successor',
        dist: {
          tarball: new URL(pathname, url).href,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      };
      time[version] = '2020-03-01T00:00:00.000Z';
    }
    const doc = {
      name,
      versions: documents,
      time,
      readme: '# Original README',
      'dist-tags': tags,
    };
    routes.set(`/hosted/${encodeURIComponent(name)}`, doc);
    return doc;
  };

  const importer = (names: string[], dryRun = false) =>
    createImportService({
      registryUrl: url,
      packagesRoot: path.join(root, 'packages'),
      baseUrl: 'https://destination.example',
      auth: { type: 'none' },
      enumerate: async () => names,
      dryRun,
      logger,
    });

  const cli = async (
    dryRun: boolean,
    secret: string | undefined = undefined
  ) => {
    const list = path.join(root, 'names.txt');
    await fs.writeFile(list, 'plain\n');
    const replies = [
      { prompt: 'Hosted registry URL', answer: url },
      { prompt: 'Package name list file', answer: list },
      {
        prompt: 'Authentication (none/basic/bearer)',
        answer: secret ? 'bearer' : 'none',
      },
      ...(secret ? [{ prompt: 'Source token', answer: secret }] : []),
      { prompt: 'Destination package directory', answer: '' },
      { prompt: dryRun ? 'Run dry-run?' : 'Start import?', answer: 'y' },
    ];
    return await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.resolve('dist/cli.mjs'),
            '--import-packages',
            ...(dryRun ? ['--dry-run'] : []),
            '-d',
            path.join(root, 'packages'),
            '-c',
            path.join(root, 'config.json'),
          ],
          { timeout: 15000 }
        );
        let output = '';
        let next = 0;
        const receive = (chunk: Buffer) => {
          output += chunk.toString();
          if (replies[next] && output.includes(replies[next]!.prompt)) {
            child.stdin.write(`${replies[next]!.answer}\n`);
            next++;
          }
        };
        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      }
    );
  };

  test('CLI imports offline and the resulting registry supports npm view and npm install', async () => {
    const doc = await publish('plain', ['1.0.0'], { latest: '1.0.0' });
    delete (doc.versions['1.0.0'] as any).dependencies;
    const outcome = await cli(false);
    expect(outcome, outcome.output).toMatchObject({ code: 0 });
    expect(outcome.output).toContain('Imported: 1');
    const port = await getTestPort();
    const destination = await startFastifyServer(
      {
        port,
        packageDir: path.join(root, 'packages'),
        configDir: root,
        authMode: 'none',
        logLevel: 'ignore',
      },
      logger
    );
    try {
      const registry = `http://127.0.0.1:${port}`;
      const npm = promisify(execFile);
      const view = await npm(
        'npm',
        ['view', 'plain', 'version', '--json', '--registry', registry],
        { cwd: root }
      );
      expect(JSON.parse(view.stdout)).toBe('1.0.0');
      await fs.writeFile(
        path.join(root, 'package.json'),
        '{"name":"consumer","private":true}'
      );
      await npm(
        'npm',
        [
          'install',
          'plain',
          '--registry',
          registry,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--cache',
          path.join(root, 'npm-cache'),
        ],
        { cwd: root }
      );
      const installed = await promisify(execFile)(
        process.execPath,
        ['-e', 'console.log(require("plain"))'],
        { cwd: root }
      );
      expect(installed.stdout.trim()).toBe('42');
    } finally {
      await destination.close();
    }
  }, 30000);

  test('CLI dry-run authenticates without echoing the token or changing package storage', async () => {
    await publish('plain', ['1.0.0'], { latest: '1.0.0' });
    const outcome = await cli(true, 'test-secret-token');
    expect(outcome, outcome.output).toMatchObject({ code: 0 });
    expect(outcome.output).not.toContain('test-secret-token');
    expect(requests[0]?.authorization).toBe('Bearer test-secret-token');
    await expect(fs.access(path.join(root, 'packages'))).rejects.toHaveProperty(
      'code',
      'ENOENT'
    );
  }, 20000);

  test('imports every supplied version unchanged and preserves metadata and explicit tags after restart', async () => {
    await publish('@acme/pkg', ['1.0.0', '2.0.0', '3.0.0-beta.1'], {
      latest: '1.0.0',
      next: '3.0.0-beta.1',
    });
    await publish('plain', ['1.0.0'], {});
    const result = await importer(['@acme/pkg', 'plain']).run();
    expect(result).toMatchObject({
      imported: 4,
      skipped: 0,
      conflicts: 0,
      failed: 0,
    });
    const metadata = createMetadataService(
      path.join(root, 'packages'),
      'https://destination.example',
      logger
    );
    await metadata.initialize();
    expect(metadata.getDistTags('@acme/pkg')).toEqual({
      latest: '1.0.0',
      next: '3.0.0-beta.1',
    });
    expect(metadata.getDistTags('plain')).toEqual({});
    const version = metadata.getPackageVersion('@acme/pkg', '2.0.0')!;
    expect(version).toMatchObject({
      published: '2020-03-01T00:00:00.000Z',
      readme: '# Original README',
      manifest: {
        dependencies: { external: '^1.0.0' },
        deprecated: 'Use the successor',
      },
    });
    expect(version.tarballUrl).toBe(
      'https://destination.example/@acme/pkg/-/pkg-2.0.0.tgz'
    );
    expect(
      await fs.readFile(
        path.join(root, 'packages/@acme/pkg/2.0.0/pkg-2.0.0.tgz')
      )
    ).toEqual(routes.get('/hosted/%40acme%2Fpkg/2.0.0.tgz'));
    expect(
      requests
        .filter((r) => !r.path.endsWith('.tgz'))
        .every((r) => r.accept === 'application/json')
    ).toBe(true);
    expect(requests.some((r) => r.path.includes('external'))).toBe(false);
  });

  test('dry-run lists names and versions without downloading tarballs or creating destination files', async () => {
    await publish('plain', ['1.0.0', '2.0.0'], { latest: '1.0.0' });
    const result = await importer(['plain', 'plain'], true).run();
    expect(result.targets).toEqual([
      { name: 'plain', versions: ['1.0.0', '2.0.0'] },
    ]);
    expect(result.failed).toBe(0);
    expect(requests.map((r) => r.path)).toEqual(['/hosted/plain']);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('preserves package and version READMEs separately and does not invent missing source dates', async () => {
    const doc = await publish('plain', ['1.0.0', '2.0.0'], { latest: '1.0.0' });
    (doc.versions['2.0.0'] as any).readme = '# Version README';
    delete doc.time['2.0.0'];
    const result = await importer(['plain']).run();
    expect(result.failed).toBe(0);
    expect(result.warnings).toContain(
      'plain@2.0.0: source publication time unavailable'
    );
    const port = await getTestPort();
    const destination = await startFastifyServer(
      {
        port,
        packageDir: path.join(root, 'packages'),
        configDir: root,
        authMode: 'none',
        logLevel: 'ignore',
      },
      logger
    );
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/plain`)).json();
      expect(body.readme).toBe('# Original README');
      expect(body.versions['2.0.0'].readme).toBe('# Version README');
      expect(body.time['2.0.0']).toBeUndefined();
    } finally {
      await destination.close();
    }
  });

  test.each(['name', 'version', 'checksum'])(
    'rejects a tarball with mismatched %s without publishing it',
    async (mismatch) => {
      const doc = await publish('plain', ['1.0.0'], { latest: '1.0.0' });
      const bytes = await tarball(
        mismatch === 'name' ? 'another' : 'plain',
        mismatch === 'version' ? '9.0.0' : '1.0.0'
      );
      routes.set('/hosted/plain/1.0.0.tgz', bytes);
      if (mismatch !== 'checksum')
        (doc.versions['1.0.0'] as any).dist = {
          tarball: `${url}plain/1.0.0.tgz`,
        };
      else (doc.versions['1.0.0'] as any).dist.shasum = '0'.repeat(40);
      const result = await importer(['plain']).run();
      expect(result.failed).toBe(2);
      const metadata = createMetadataService(
        path.join(root, 'packages'),
        '',
        logger
      );
      await metadata.initialize();
      expect(metadata.getAllPackageIds()).toEqual([]);
    }
  );

  test('never overwrites a different tarball at the same name and version', async () => {
    await publish('plain', ['1.0.0'], { latest: '1.0.0' });
    expect((await importer(['plain']).run()).imported).toBe(1);
    const before = await fs.readFile(
      path.join(root, 'packages/plain/1.0.0/plain-1.0.0.tgz')
    );
    (routes.get('/hosted/plain') as any).versions['1.0.0'].dist.shasum =
      '0'.repeat(40);
    const result = await importer(['plain']).run();
    expect(result.conflicts).toBe(1);
    expect(
      await fs.readFile(path.join(root, 'packages/plain/1.0.0/plain-1.0.0.tgz'))
    ).toEqual(before);
  });

  test('reports failed metadata requests and validates name lists', async () => {
    expect((await importer(['missing']).run()).failed).toBe(1);
    expect(parsePackageNames('plain\n@acme/pkg\n\nplain\n')).toEqual([
      'plain',
      '@acme/pkg',
    ]);
    expect(() => parsePackageNames('../secret')).toThrow();
  });

  test.each([
    { type: 'basic', username: 'reader', password: 'test-password' },
    { type: 'bearer', token: 'test-token' },
  ] as const)(
    'authenticates every metadata and archive request with $type',
    async (auth) => {
      await publish('plain', ['1.0.0'], { latest: '1.0.0' });
      requiredAuthorization =
        auth.type === 'basic'
          ? `Basic ${Buffer.from('reader:test-password').toString('base64')}`
          : 'Bearer test-token';
      expect((await importer(['plain']).run()).failed).toBe(1);
      requests.length = 0;
      const result = await createImportService({
        registryUrl: url,
        packagesRoot: path.join(root, 'packages'),
        baseUrl: '',
        auth,
        enumerate: async () => ['plain'],
        dryRun: false,
        logger,
      }).run();
      expect(result).toMatchObject({ imported: 1, failed: 0 });
      expect(requests).toHaveLength(2);
      expect(
        requests.every(
          (request) => request.authorization === requiredAuthorization
        )
      ).toBe(true);
    }
  );

  test('does not forward credentials to another origin or outside the registry path', async () => {
    let received: string | undefined = 'not contacted';
    const other = createServer((req, res) => {
      received = req.headers.authorization;
      res.end('{}');
    });
    other.listen(0, '127.0.0.1');
    await once(other, 'listening');
    try {
      const destination = `http://127.0.0.1:${(other.address() as { port: number }).port}/archive`;
      server.removeAllListeners('request');
      const receivedHere: Array<string | undefined> = [];
      server.on('request', (req, res) => {
        receivedHere.push(req.headers.authorization);
        if (req.url === '/outside') res.end('{}');
        else
          res
            .writeHead(302, {
              Location: req.url === '/hosted/cross' ? destination : '/outside',
            })
            .end();
      });
      const client = createImportHttpClient(
        { type: 'bearer', token: 'secret' },
        [url]
      );
      await client.json(`${url}cross`);
      expect(received).toBeUndefined();
      await client.json(`${url}same`);
      expect(receivedHere).toEqual([
        'Bearer secret',
        'Bearer secret',
        undefined,
      ]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});
