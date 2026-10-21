import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { enumerateNexusPackages } from '../src/services/nexusImportSource';

describe('Nexus import enumeration', () => {
  let server: Server;
  let apiUrl: string;
  let pages: Map<string | null, { status: number; body: unknown }>;
  let requests: Array<{ url: URL; authorization: string | undefined }>;

  beforeEach(async () => {
    pages = new Map();
    requests = [];
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      requests.push({ url, authorization: request.headers.authorization });
      const page = pages.get(url.searchParams.get('continuationToken'));
      response.writeHead(page?.status ?? 404, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify(page?.body ?? {}));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/reverse/nexus/service/rest/v1/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  test('enumerates every page, restores scopes and deduplicates versions without assuming page sizes', async () => {
    const firstToken = 'cursor +/&?=';
    pages.set(null, {
      status: 200,
      body: {
        items: [
          {
            repository: 'npm-hosted',
            format: 'npm',
            group: '',
            name: 'plain',
            version: '1.0.0',
          },
          {
            repository: 'npm-hosted',
            format: 'npm',
            group: '',
            name: 'plain',
            version: '2.0.0',
          },
          {
            repository: 'npm-hosted',
            format: 'npm',
            group: 'acme',
            name: 'scoped',
            version: '1.0.0',
          },
        ],
        continuationToken: firstToken,
      },
    });
    pages.set(firstToken, {
      status: 200,
      body: { items: [], continuationToken: 'last' },
    });
    pages.set('last', {
      status: 200,
      body: {
        items: [
          {
            repository: 'npm-hosted',
            format: 'npm',
            group: 'acme',
            name: 'scoped',
            version: '2.0.0-beta.1',
          },
          {
            repository: 'npm-hosted',
            format: 'npm',
            group: null,
            name: 'other',
            version: '1.0.0',
          },
        ],
        continuationToken: null,
      },
    });

    await expect(
      enumerateNexusPackages(apiUrl, 'npm-hosted', { type: 'none' })
    ).resolves.toEqual(['plain', '@acme/scoped', 'other']);
    expect(
      requests.map(({ url }) => url.searchParams.get('continuationToken'))
    ).toEqual([null, firstToken, 'last']);
    expect(
      requests.every(
        ({ url }) =>
          url.pathname === '/reverse/nexus/service/rest/v1/components'
      )
    ).toBe(true);
    expect(
      requests.every(
        ({ url }) => url.searchParams.get('repository') === 'npm-hosted'
      )
    ).toBe(true);
  });

  test('accepts an empty hosted repository and an API URL without a trailing slash', async () => {
    pages.set(null, {
      status: 200,
      body: { items: [], continuationToken: null },
    });
    await expect(
      enumerateNexusPackages(apiUrl.slice(0, -1), 'npm-hosted', {
        type: 'none',
      })
    ).resolves.toEqual([]);
    expect(requests[0]!.url.pathname).toBe(
      '/reverse/nexus/service/rest/v1/components'
    );
  });

  test.each([
    { type: 'basic', username: 'reader', password: 'test-password' },
    { type: 'bearer', token: 'test-token' },
  ] as const)(
    'authenticates each page using $type credentials',
    async (auth) => {
      pages.set(null, {
        status: 200,
        body: { items: [], continuationToken: 'next' },
      });
      pages.set('next', {
        status: 200,
        body: { items: [], continuationToken: null },
      });
      await enumerateNexusPackages(apiUrl, 'npm-hosted', auth);
      const expected =
        auth.type === 'basic'
          ? `Basic ${Buffer.from('reader:test-password').toString('base64')}`
          : 'Bearer test-token';
      expect(requests.map(({ authorization }) => authorization)).toEqual([
        expected,
        expected,
      ]);
    }
  );

  test.each([
    { repository: 'other-hosted', format: 'npm', group: '', name: 'plain' },
    { repository: 'npm-hosted', format: 'maven2', group: '', name: 'plain' },
    { repository: 'npm-hosted', format: 'npm', group: '', name: '../outside' },
    {
      repository: 'npm-hosted',
      format: 'npm',
      group: 'bad/scope',
      name: 'plain',
    },
    { repository: 'npm-hosted', format: 'npm', group: 123, name: 'plain' },
    { repository: 'npm-hosted', format: 'npm', group: '', name: null },
    null,
  ])(
    'rejects a component that cannot identify an npm package in the requested repository: %j',
    async (component) => {
      pages.set(null, {
        status: 200,
        body: { items: [component], continuationToken: null },
      });
      await expect(
        enumerateNexusPackages(apiUrl, 'npm-hosted', { type: 'none' })
      ).rejects.toThrow();
    }
  );

  test.each([
    null,
    [],
    { items: {}, continuationToken: null },
    { items: [] },
    { items: [], continuationToken: 123 },
    { items: [], continuationToken: '' },
  ])(
    'rejects malformed pages instead of returning an incomplete inventory: %j',
    async (body) => {
      pages.set(null, { status: 200, body });
      await expect(
        enumerateNexusPackages(apiUrl, 'npm-hosted', { type: 'none' })
      ).rejects.toThrow();
    }
  );

  test('rejects the entire enumeration when a subsequent page fails', async () => {
    pages.set(null, {
      status: 200,
      body: {
        items: [
          { repository: 'npm-hosted', format: 'npm', group: '', name: 'plain' },
        ],
        continuationToken: 'next',
      },
    });
    pages.set('next', { status: 503, body: {} });
    await expect(
      enumerateNexusPackages(apiUrl, 'npm-hosted', { type: 'none' })
    ).rejects.toThrow('HTTP 503');
    expect(requests).toHaveLength(2);
  });

  test('rejects a continuation-token cycle before requesting a repeated page', async () => {
    pages.set(null, {
      status: 200,
      body: { items: [], continuationToken: 'a' },
    });
    pages.set('a', {
      status: 200,
      body: { items: [], continuationToken: 'b' },
    });
    pages.set('b', {
      status: 200,
      body: { items: [], continuationToken: 'a' },
    });
    await expect(
      enumerateNexusPackages(apiUrl, 'npm-hosted', { type: 'none' })
    ).rejects.toThrow(/continuation/i);
    expect(requests).toHaveLength(3);
  });

  test.each(['', '../other', 'npm?repository=other', 'npm hosted'])(
    'rejects an invalid repository name before making a request: %s',
    async (repository) => {
      await expect(
        enumerateNexusPackages(apiUrl, repository, { type: 'none' })
      ).rejects.toThrow();
      expect(requests).toEqual([]);
    }
  );

  test('rejects a query in the API base URL instead of silently replacing it', async () => {
    await expect(
      enumerateNexusPackages(`${apiUrl}?repository=other`, 'npm-hosted', {
        type: 'none',
      })
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
