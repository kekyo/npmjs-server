import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import fs from 'fs/promises';
import { createServer, type Server } from 'http';
import os from 'os';
import path from 'path';
import { createFileItem, createTarPacker } from 'tar-vern';

type Reply = {
  prompt: string;
  answer: string | null | { end: string } | { signal: NodeJS.Signals };
};

const executable = path.resolve('dist/cli.mjs');

describe('offline import CLI lifecycle', () => {
  let root: string;
  let configFile: string;
  let listFile: string;
  let server: Server;
  let registry: string;
  let archives: Map<string, Buffer>;
  let versions: string[];
  let status: number;
  let requests: Array<{ path: string; authorization: string | undefined }>;
  let activeChild: ChildProcessWithoutNullStreams | undefined;
  let interrupt: { version: string; signal: NodeJS.Signals } | undefined;
  const secret = 'private-source-credential-123';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-import-cli-'));
    configFile = path.join(root, 'settings', 'config.json');
    listFile = path.join(root, 'names.txt');
    await fs.mkdir(path.dirname(configFile));
    await fs.writeFile(
      configFile,
      JSON.stringify({
        packageDir: './normal-packages',
        proxy: { enabled: true, packageDir: './proxy-packages' },
      })
    );
    await fs.writeFile(listFile, 'plain\n');
    requests = [];
    versions = ['1.0.0'];
    status = 200;
    interrupt = undefined;
    activeChild = undefined;
    archives = new Map();
    for (const version of ['1.0.0', '2.0.0']) {
      const item = await createFileItem(
        'package/package.json',
        JSON.stringify({ name: 'plain', version })
      );
      const chunks: Buffer[] = [];
      for await (const chunk of createTarPacker(
        (async function* () {
          yield item;
        })(),
        'gzip'
      ))
        chunks.push(Buffer.from(chunk));
      archives.set(version, Buffer.concat(chunks));
    }
    server = createServer((request, response) => {
      const pathname = new URL(request.url!, registry).pathname;
      requests.push({
        path: pathname,
        authorization: request.headers.authorization,
      });
      if (status !== 200) {
        response.writeHead(status).end(JSON.stringify({ message: secret }));
        return;
      }
      if (pathname === '/management/service/rest/v1/components') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            items: [
              {
                repository: 'npm-hosted',
                format: 'npm',
                group: '',
                name: 'plain',
              },
            ],
            continuationToken: null,
          })
        );
        return;
      }
      if (pathname === '/hosted/plain') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            name: 'plain',
            versions: Object.fromEntries(
              versions.map((version) => [
                version,
                {
                  name: 'plain',
                  version,
                  dist: {
                    tarball: `${registry}plain/${version}.tgz`,
                    shasum: createHash('sha1')
                      .update(archives.get(version)!)
                      .digest('hex'),
                  },
                },
              ])
            ),
            'dist-tags': { latest: versions.at(-1) },
          })
        );
        return;
      }
      const version = versions.find(
        (value) => pathname === `/hosted/plain/${value}.tgz`
      );
      if (version) {
        if (interrupt?.version === version) {
          const signal = interrupt.signal;
          interrupt = undefined;
          // Interrupt after the request arrives, without relying on elapsed time.
          activeChild!.kill(signal);
          return;
        }
        response.end(archives.get(version));
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/hosted/`;
  });

  afterEach(async () => {
    if (
      activeChild &&
      activeChild.exitCode === null &&
      activeChild.signalCode === null
    ) {
      activeChild.kill('SIGKILL');
      await once(activeChild, 'close');
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  const replies = (authentication: 'none' | 'basic' | 'bearer'): Reply[] => [
    { prompt: 'Enumeration method (list/nexus)', answer: 'list' },
    { prompt: 'Hosted registry URL', answer: registry },
    { prompt: 'Package name list file', answer: listFile },
    { prompt: 'Authentication (none/basic/bearer)', answer: authentication },
    ...(authentication === 'basic'
      ? [{ prompt: 'Source username', answer: 'migration-user' }]
      : []),
    ...(authentication === 'none'
      ? []
      : [
          {
            prompt:
              authentication === 'basic' ? 'Source password' : 'Source token',
            answer: secret,
          },
        ]),
    { prompt: 'Destination package directory', answer: '' },
    { prompt: 'Start import?', answer: 'y' },
  ];

  const run = async (
    input: Reply[],
    args: string[],
    environment: Record<string, string>
  ) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('NPMJS_SERVER_')
      )
    );
    return await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [executable, '--import-packages', '-c', configFile, ...args],
        {
          cwd: root,
          env: { ...env, HOME: root, USERPROFILE: root, ...environment },
          timeout: 15000,
          killSignal: 'SIGKILL',
        }
      );
      activeChild = child;
      let output = '';
      let next = 0;
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const reply = input[next];
        if (!reply || !output.includes(reply.prompt)) return;
        next++;
        if (reply.answer === null) child.stdin.end();
        else if (typeof reply.answer === 'string')
          child.stdin.write(`${reply.answer}\n`);
        else if ('end' in reply.answer) child.stdin.end(reply.answer.end);
        else child.kill(reply.answer.signal);
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, output }));
    });
  };

  test.each([0, 2, 5])(
    'EOF at prompt %i reports an incomplete import',
    async (position) => {
      const input = replies('none').slice(0, position + 1);
      input[position]!.answer = null;
      const outcome = await run(input, [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 1, signal: null });
      expect(outcome.output).toMatch(/interrupted|failed/i);
      expect(outcome.output).not.toContain('Import cancelled.');
      expect(requests).toEqual([]);
    }
  );

  test.each([false, true])(
    'uses npmrc registry and Bearer credentials after consent (dry-run: %s)',
    async (dryRun) => {
      const npmrc = `registry=${registry}\n//${new URL(registry).host}/hosted/:_authToken=\${IMPORT_TEST_TOKEN}\n`;
      await fs.writeFile(path.join(root, '.npmrc'), npmrc);
      const outcome = await run(
        [
          { prompt: 'Enumeration method (list/nexus)', answer: 'list' },
          { prompt: 'Use settings from ~/.npmrc?', answer: 'y' },
          { prompt: 'Package name list file', answer: listFile },
          { prompt: 'Destination package directory', answer: '' },
          { prompt: dryRun ? 'Run dry-run?' : 'Start import?', answer: 'y' },
        ],
        dryRun ? ['--dry-run'] : [],
        { IMPORT_TEST_TOKEN: secret }
      );
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(outcome.output).not.toMatch(
        /Hosted registry URL:|Authentication \(|Source token:/
      );
      expect(outcome.output).not.toContain(secret);
      expect(requests).toHaveLength(dryRun ? 1 : 2);
      expect(
        requests.every(
          ({ authorization }) => authorization === `Bearer ${secret}`
        )
      ).toBe(true);
      expect(await fs.readFile(path.join(root, '.npmrc'), 'utf8')).toBe(npmrc);
      if (dryRun)
        await expect(
          fs.stat(path.join(root, 'settings', 'normal-packages'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  test.each(['n', ''])(
    'declining npmrc with %j uses only manually supplied settings',
    async (answer) => {
      await fs.writeFile(
        path.join(root, '.npmrc'),
        `registry=https://unused.example/\n//${new URL(registry).host}/:_authToken=${secret}`
      );
      const input = replies('none');
      input.splice(1, 0, { prompt: 'Use settings from ~/.npmrc?', answer });
      const outcome = await run(input, [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(outcome.output).toContain('Hosted registry URL:');
      expect(requests).toHaveLength(2);
      expect(
        requests.every(({ authorization }) => authorization === undefined)
      ).toBe(true);
      expect(outcome.output).not.toContain(secret);
    }
  );

  test.each(['empty', 'invalid', 'directory'])(
    'falls back to manual input for an %s npmrc',
    async (kind) => {
      if (kind === 'directory') await fs.mkdir(path.join(root, '.npmrc'));
      else
        await fs.writeFile(
          path.join(root, '.npmrc'),
          kind === 'empty'
            ? ''
            : 'registry=https://user:private-secret@example.org/\n//example.org/:_authToken=${UNSET_IMPORT_TEST_TOKEN}'
        );
      const outcome = await run(replies('none'), [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(outcome.output).not.toContain('Use settings from ~/.npmrc?');
      expect(outcome.output).not.toContain('private-secret');
      expect(requests).toHaveLength(2);
    }
  );

  test.each([true, false])(
    'resolves authentication-only npmrc after manual URL input (matching: %s)',
    async (matching) => {
      await fs.writeFile(
        path.join(root, '.npmrc'),
        `//${new URL(registry).host}/${matching ? 'hosted' : 'unrelated'}/:_authToken=${secret}`
      );
      const input = replies('none');
      input.splice(1, 0, {
        prompt: 'Use settings from ~/.npmrc?',
        answer: 'y',
      });
      if (matching) input.splice(4, 1);
      const outcome = await run(input, [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(requests).toHaveLength(2);
      expect(
        requests.every(
          ({ authorization }) =>
            authorization === (matching ? `Bearer ${secret}` : undefined)
        )
      ).toBe(true);
      expect(outcome.output).not.toContain(secret);
    }
  );

  test('asks for one registry when multiple distinct URLs are configured', async () => {
    await fs.writeFile(
      path.join(root, '.npmrc'),
      `registry=https://unused.example/\n@team:registry=${registry}\n@alias:registry=${registry}`
    );
    const input = replies('none');
    input.splice(
      1,
      1,
      { prompt: 'Use settings from ~/.npmrc?', answer: 'y' },
      { prompt: 'Registry number', answer: '2' }
    );
    const outcome = await run(input, [], {});
    expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
    expect(outcome.output).not.toContain('Hosted registry URL:');
    expect(requests).toHaveLength(2);
  });

  test.each(['n', 'eof'])(
    'npmrc import makes no requests when stopped at confirmation: %s',
    async (stop) => {
      await fs.writeFile(
        path.join(root, '.npmrc'),
        `registry=${registry}\n//${new URL(registry).host}/:_authToken=${secret}`
      );
      const input: Reply[] = [
        { prompt: 'Enumeration method (list/nexus)', answer: 'list' },
        {
          prompt: 'Use settings from ~/.npmrc?',
          answer: stop === 'eof' ? null : 'y',
        },
      ];
      if (stop === 'n')
        input.push(
          { prompt: 'Package name list file', answer: listFile },
          { prompt: 'Destination package directory', answer: '' },
          { prompt: 'Start import?', answer: 'n' }
        );
      const outcome = await run(input, [], {});
      expect(outcome, outcome.output).toMatchObject({
        code: stop === 'eof' ? 1 : 0,
        signal: null,
      });
      expect(requests).toEqual([]);
      expect(outcome.output).not.toContain(secret);
      await expect(
        fs.stat(path.join(root, 'settings', 'normal-packages'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  test('Nexus keeps the npmrc URL and asks for Basic authentication instead of using Bearer', async () => {
    await fs.writeFile(
      path.join(root, '.npmrc'),
      `registry=${registry}\n//${new URL(registry).host}/:_authToken=unusable-nexus-token`
    );
    const outcome = await run(
      [
        { prompt: 'Enumeration method (list/nexus)', answer: 'nexus' },
        { prompt: 'Use settings from ~/.npmrc?', answer: 'y' },
        {
          prompt: 'Nexus REST API base URL',
          answer: new URL('/management/service/rest/v1/', registry).href,
        },
        { prompt: 'Nexus repository name', answer: 'npm-hosted' },
        { prompt: 'Authentication (none/basic)', answer: 'basic' },
        { prompt: 'Source username', answer: 'migration-user' },
        { prompt: 'Source password', answer: secret },
        { prompt: 'Destination package directory', answer: '' },
        { prompt: 'Start import?', answer: 'y' },
      ],
      [],
      {}
    );
    expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
    expect(outcome.output).toMatch(/Bearer.*Nexus/);
    expect(outcome.output).not.toContain('Authentication (none/basic/bearer)');
    expect(outcome.output).not.toMatch(/unusable-nexus-token|Source token:/);
    expect(requests).toHaveLength(3);
    const expected = `Basic ${Buffer.from(`migration-user:${secret}`).toString('base64')}`;
    expect(
      requests.every(({ authorization }) => authorization === expected)
    ).toBe(true);
  });

  test.each(['host', 'separate', 'manual-api'])(
    'Nexus resolves Basic credentials independently for the registry and API: %s',
    async (scope) => {
      const host = new URL(registry).host;
      const sourceAuth = Buffer.from('source-user:source-password').toString(
        'base64'
      );
      const apiAuth = Buffer.from('api-user:api-password').toString('base64');
      await fs.writeFile(
        path.join(root, '.npmrc'),
        `registry=${registry}\n//${host}/${scope === 'host' ? '' : 'hosted/'}:_auth=${sourceAuth}\n${scope === 'separate' ? `//${host}/management/:_auth=${apiAuth}` : ''}`
      );
      const input: Reply[] = [
        { prompt: 'Enumeration method (list/nexus)', answer: 'nexus' },
        { prompt: 'Use settings from ~/.npmrc?', answer: 'y' },
        {
          prompt: 'Nexus REST API base URL',
          answer: new URL('/management/service/rest/v1/', registry).href,
        },
        { prompt: 'Nexus repository name', answer: 'npm-hosted' },
      ];
      if (scope === 'manual-api')
        input.push({
          prompt: 'Nexus API authentication (none/basic)',
          answer: 'none',
        });
      input.push(
        { prompt: 'Destination package directory', answer: '' },
        { prompt: 'Start import?', answer: 'y' }
      );
      const outcome = await run(input, [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(requests.map(({ authorization }) => authorization)).toEqual([
        scope === 'host'
          ? `Basic ${sourceAuth}`
          : scope === 'separate'
            ? `Basic ${apiAuth}`
            : undefined,
        `Basic ${sourceAuth}`,
        `Basic ${sourceAuth}`,
      ]);
      expect(outcome.output).not.toMatch(/source-password|api-password/);
      expect(outcome.output).not.toContain(sourceAuth);
      expect(outcome.output).not.toContain(apiAuth);
    }
  );

  test.each(['basic', 'bearer'] as const)(
    'EOF during %s secret input fails without revealing credentials',
    async (authentication) => {
      const input = replies(authentication);
      const position = input.findIndex(
        (reply) =>
          reply.prompt ===
          (authentication === 'basic' ? 'Source password' : 'Source token')
      );
      input[position]!.answer = null;
      const outcome = await run(input.slice(0, position + 1), [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 1, signal: null });
      expect(outcome.output).not.toContain(secret);
      expect(requests).toEqual([]);
    }
  );

  test('SIGINT at a prompt cannot report a successful import', async () => {
    const outcome = await run(
      [
        {
          prompt: 'Enumeration method (list/nexus)',
          answer: { signal: 'SIGINT' },
        },
      ],
      [],
      {}
    );
    expect(outcome.code).not.toBe(0);
    expect(outcome.signal === 'SIGINT' || outcome.code === 1).toBe(true);
    expect(outcome.output).not.toContain('Import result:');
    expect(requests).toEqual([]);
  });

  test.each(['n', ''])(
    'explicit cancellation with %j exits successfully without requests or writes',
    async (answer) => {
      const input = replies('none');
      input.at(-1)!.answer = answer;
      const outcome = await run(input, [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(outcome.output).toContain('Import cancelled.');
      expect(requests).toEqual([]);
      await expect(
        fs.stat(path.join(root, 'settings', 'normal-packages'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  test('a missing package list reports incomplete enumeration and a nonzero exit', async () => {
    await fs.unlink(listFile);
    const outcome = await run(replies('none'), [], {});
    expect(outcome, outcome.output).toMatchObject({ code: 1, signal: null });
    expect(outcome.output).toContain('Package enumeration failed');
    expect(outcome.output).toContain('Failed: 1');
    expect(requests).toEqual([]);
  });

  test('Nexus enumeration failure reports a nonzero exit without exposing response or credentials', async () => {
    status = 503;
    const input = replies('basic');
    input[3]!.prompt = 'Authentication (none/basic)';
    input[0]!.answer = 'nexus';
    input.splice(
      2,
      1,
      {
        prompt: 'Nexus REST API base URL',
        answer: new URL('/management/service/rest/v1/', registry).href,
      },
      { prompt: 'Nexus repository name', answer: 'npm-hosted' }
    );
    const outcome = await run(input, [], {});
    expect(outcome, outcome.output).toMatchObject({ code: 1, signal: null });
    expect(outcome.output).toContain('Package enumeration failed');
    expect(outcome.output).toContain('Failed: 1');
    expect(outcome.output).not.toContain(secret);
    expect(requests).toEqual([
      {
        path: '/management/service/rest/v1/components',
        authorization: `Basic ${Buffer.from(`migration-user:${secret}`).toString('base64')}`,
      },
    ]);
  });

  test.each([401, 404, 503])(
    'metadata HTTP %i is an incomplete import with a nonzero exit',
    async (failureStatus) => {
      status = failureStatus;
      const outcome = await run(replies('bearer'), [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 1, signal: null });
      expect(outcome.output).toContain(
        'plain: metadata request or validation failed'
      );
      expect(outcome.output).toContain('Failed: 1');
      expect(outcome.output).not.toContain(secret);
      expect(requests).toEqual([
        { path: '/hosted/plain', authorization: `Bearer ${secret}` },
      ]);
    }
  );

  test.each(['basic', 'bearer'] as const)(
    '%s credentials remain hidden during a successful import',
    async (authentication) => {
      const outcome = await run(replies(authentication), [], {});
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(outcome.output).toContain('Imported: 1');
      const authorization =
        authentication === 'basic'
          ? `Basic ${Buffer.from(`migration-user:${secret}`).toString('base64')}`
          : `Bearer ${secret}`;
      expect(requests).toHaveLength(2);
      expect(
        requests.every((request) => request.authorization === authorization)
      ).toBe(true);
      expect(outcome.output).not.toContain(secret);
      expect(outcome.output).not.toContain(authorization);
    }
  );

  test.each(['config', 'environment', 'option'] as const)(
    'destination defaults to the resolved %s package directory, separate from proxy storage',
    async (source) => {
      const configured = path.join(root, 'settings', 'normal-packages');
      const fromEnvironment = path.join(root, 'env-packages');
      const fromOption = path.join(root, 'option-packages');
      const destination =
        source === 'option'
          ? fromOption
          : source === 'environment'
            ? fromEnvironment
            : configured;
      const outcome = await run(
        replies('none'),
        source === 'option' ? ['-d', fromOption] : [],
        source === 'config' ? {} : { NPMJS_SERVER_PACKAGE_DIR: fromEnvironment }
      );
      expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
      expect(outcome.output).toContain(
        `Destination package directory [${destination}]`
      );
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(destination, 'plain', '1.0.0', 'package.json'),
          'utf8'
        )
      );
      expect(manifest).toMatchObject({ name: 'plain', version: '1.0.0' });
      await expect(
        fs.stat(path.join(root, 'settings', 'proxy-packages'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      if (destination !== configured)
        await expect(fs.stat(configured)).rejects.toMatchObject({
          code: 'ENOENT',
        });
    }
  );

  test('stdin may close after affirmative confirmation without interrupting the import', async () => {
    const input = replies('none');
    input.at(-1)!.answer = { end: 'y\n' };
    const outcome = await run(input, [], {});
    expect(outcome, outcome.output).toMatchObject({ code: 0, signal: null });
    expect(outcome.output).toContain('Imported: 1');
  });

  test.each(['SIGINT', 'SIGKILL'] as const)(
    'after %s during transfer, rerunning retains completed archives and fetches the unfinished version',
    async (signal) => {
      versions = ['1.0.0', '2.0.0'];
      interrupt = { version: '2.0.0', signal };
      const interrupted = await run(replies('none'), [], {});
      expect(interrupted, interrupted.output).toMatchObject({
        code: null,
        signal,
      });
      expect(interrupted.output).not.toContain('Import result:');
      const destination = path.join(
        root,
        'settings',
        'normal-packages',
        'plain'
      );
      const completed = path.join(destination, '1.0.0', 'plain-1.0.0.tgz');
      expect(await fs.readFile(completed)).toEqual(archives.get('1.0.0'));
      const before = await fs.stat(completed);
      await expect(
        fs.stat(path.join(destination, '2.0.0'))
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const resumed = await run(replies('none'), [], {});
      expect(resumed, resumed.output).toMatchObject({ code: 0, signal: null });
      expect(resumed.output).toContain(
        'Imported: 1; Skipped: 1; Conflicts: 0; Failed: 0'
      );
      expect(await fs.readFile(completed)).toEqual(archives.get('1.0.0'));
      expect((await fs.stat(completed)).mtimeMs).toBe(before.mtimeMs);
      expect(
        await fs.readFile(path.join(destination, '2.0.0', 'plain-2.0.0.tgz'))
      ).toEqual(archives.get('2.0.0'));
      expect(
        requests.filter((request) => request.path.endsWith('/1.0.0.tgz'))
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.path.endsWith('/2.0.0.tgz'))
      ).toHaveLength(2);
    }
  );
});
