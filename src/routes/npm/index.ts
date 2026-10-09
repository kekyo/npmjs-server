// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { randomUUID } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ReaderWriterLock } from 'async-primitives';
import { Logger } from '../../types';
import {
  MetadataService,
  PackageDistTags,
  PackageVersionMetadata,
} from '../../services/metadataService';
import { AuthService } from '../../services/authService';
import { UserService } from '../../services/userService';
import type { TotpService } from '../../services/totpService';
import { createPackageService } from '../../services/packageService';
import { publishNpmTarball } from '../../services/npmPublishService';
import {
  createNpmHybridAuthMiddleware,
  FastifyAuthConfig,
  AuthenticatedFastifyRequest,
} from '../../middleware/fastifyAuth';
import { createUrlResolver } from '../../utils/urlResolver';
import {
  buildPackageName,
  createTarballFileName,
  decodePackageName,
  encodePackageNameForPath,
  isValidPackageName,
} from '../../utils/npmPackage';
import { streamFile } from '../../utils/fileStreaming';
import {
  isNpmProxyError,
  NpmProxyService,
} from '../../services/npmProxyService';

/**
 * Configuration for npm registry routes.
 */
export interface NpmRoutesConfig {
  metadataService: MetadataService;
  authService: AuthService;
  userService: UserService;
  /** Shared second-factor verification and attempt limits for token issuance. */
  totpService: TotpService;
  authConfig: FastifyAuthConfig;
  packagesRoot: string;
  logger: Logger;
  urlResolver: ReturnType<typeof createUrlResolver>;
  proxyMetadataService?: MetadataService;
  proxyService?: NpmProxyService;
}

interface NpmLoginFlow {
  id: string;
  createdAt: number;
  token?: string;
  username?: string;
  /** Password-verified challenge; no token is issued until it is consumed. */
  totpChallenge?: string;
}

type PackumentDocument = Record<string, any>;

const getObject = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const getPackumentVersions = (
  packument: PackumentDocument | undefined
): Record<string, any> => getObject(packument?.versions) ?? {};

const getPackumentDistTags = (
  packument: PackumentDocument | undefined
): PackageDistTags => {
  const tags = getObject(packument?.['dist-tags']);
  return tags
    ? Object.fromEntries(
        Object.entries(tags).filter((entry): entry is [string, string] => {
          const [tag, version] = entry;
          return typeof tag === 'string' && typeof version === 'string';
        })
      )
    : {};
};

const createVersionDocument = (metadata: PackageVersionMetadata) => ({
  ...metadata.manifest,
  _id: `${metadata.name}@${metadata.version}`,
  name: metadata.name,
  version: metadata.version,
  readme: metadata.manifest.readme ?? metadata.readme,
  dist: {
    ...(typeof metadata.manifest.dist === 'object'
      ? metadata.manifest.dist
      : {}),
    tarball: metadata.tarballUrl,
    shasum: metadata.shasum,
    integrity: metadata.integrity,
  },
});

const createPackument = (
  baseUrl: string,
  packageName: string,
  metadataService: MetadataService
) => {
  const versions = metadataService.getPackageMetadata(packageName);
  if (versions.length === 0) {
    return undefined;
  }

  const latest = versions[0]!;
  const versionDocuments = Object.fromEntries(
    versions.map((metadata) => [
      metadata.version,
      createVersionDocument({
        ...metadata,
        tarballUrl: `${baseUrl}/${encodePackageNameForPath(metadata.name)}/-/${encodeURIComponent(metadata.tarballName)}`,
      }),
    ])
  );
  const time = Object.fromEntries(
    versions.map((metadata) => [metadata.version, metadata.published])
  );
  const sortedPublishedTimes = versions
    .map((metadata) => metadata.published)
    .sort();

  return {
    _id: latest.name,
    name: latest.name,
    description: latest.manifest.description ?? '',
    'dist-tags': metadataService.getDistTags(packageName),
    versions: versionDocuments,
    time: {
      created: sortedPublishedTimes[0],
      modified: sortedPublishedTimes[sortedPublishedTimes.length - 1],
      ...time,
    },
    readme: latest.readme ?? latest.manifest.readme ?? '',
    maintainers: latest.manifest.maintainers ?? [],
    keywords: latest.manifest.keywords ?? [],
    license: latest.manifest.license,
    repository: latest.manifest.repository,
    homepage: latest.manifest.homepage,
    bugs: latest.manifest.bugs,
  };
};

const createProxiedVersionDocument = (
  baseUrl: string,
  packageName: string,
  version: string,
  versionDocument: Record<string, any>
): Record<string, any> => {
  const name =
    typeof versionDocument.name === 'string'
      ? versionDocument.name
      : packageName;
  const resolvedVersion =
    typeof versionDocument.version === 'string'
      ? versionDocument.version
      : version;
  const dist = getObject(versionDocument.dist) ?? {};
  return {
    ...versionDocument,
    _id: `${name}@${resolvedVersion}`,
    name,
    version: resolvedVersion,
    dist: {
      ...dist,
      tarball: `${baseUrl}/${encodePackageNameForPath(name)}/-/${encodeURIComponent(
        createTarballFileName(name, resolvedVersion)
      )}`,
    },
  };
};

const createProxiedPackument = (
  baseUrl: string,
  packageName: string,
  upstreamPackument: PackumentDocument
): PackumentDocument | undefined => {
  const versions = Object.fromEntries(
    Object.entries(getPackumentVersions(upstreamPackument))
      .map(([version, versionDocument]) => {
        const document = getObject(versionDocument);
        return document
          ? [
              version,
              createProxiedVersionDocument(
                baseUrl,
                packageName,
                version,
                document
              ),
            ]
          : undefined;
      })
      .filter(
        (entry): entry is [string, Record<string, any>] => entry !== undefined
      )
  );
  if (Object.keys(versions).length === 0) {
    return undefined;
  }

  return {
    ...upstreamPackument,
    _id:
      typeof upstreamPackument._id === 'string'
        ? upstreamPackument._id
        : packageName,
    name:
      typeof upstreamPackument.name === 'string'
        ? upstreamPackument.name
        : packageName,
    'dist-tags': getPackumentDistTags(upstreamPackument),
    versions,
  };
};

const mergePackuments = (
  packageName: string,
  packuments: Array<PackumentDocument | undefined>
): PackumentDocument | undefined => {
  const available = packuments.filter(
    (packument): packument is PackumentDocument => packument !== undefined
  );
  if (available.length === 0) {
    return undefined;
  }

  const merged = available.reduce<PackumentDocument>(
    (accumulator, packument) => ({
      ...accumulator,
      ...packument,
    }),
    {}
  );
  const versions = Object.assign(
    {},
    ...available.map((packument) => getPackumentVersions(packument))
  );
  const distTags = Object.assign(
    {},
    ...available.map((packument) => getPackumentDistTags(packument))
  );
  const time = Object.assign(
    {},
    ...available.map((packument) => getObject(packument.time) ?? {})
  );

  return {
    ...merged,
    _id: typeof merged._id === 'string' ? merged._id : packageName,
    name: typeof merged.name === 'string' ? merged.name : packageName,
    'dist-tags': distTags,
    versions,
    ...(Object.keys(time).length > 0 ? { time } : {}),
  };
};

const getVersionDocumentFromPackument = (
  packument: PackumentDocument,
  versionOrTag: string
):
  | {
      version: string;
      versionDocument: Record<string, any>;
    }
  | undefined => {
  const tags = getPackumentDistTags(packument);
  const version = tags[versionOrTag] ?? versionOrTag;
  const versionDocument = getObject(getPackumentVersions(packument)[version]);
  return versionDocument ? { version, versionDocument } : undefined;
};

const getTarballNameFromUrl = (tarballUrl: unknown): string | undefined => {
  if (typeof tarballUrl !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(tarballUrl);
    const lastSegment = url.pathname.split('/').pop();
    return lastSegment ? decodePackageName(lastSegment) : undefined;
  } catch {
    const lastSegment = tarballUrl.split('/').pop();
    return lastSegment ? decodePackageName(lastSegment) : undefined;
  }
};

const getVersionDocumentByTarballName = (
  packument: PackumentDocument,
  packageName: string,
  tarballName: string
):
  | {
      version: string;
      versionDocument: Record<string, any>;
    }
  | undefined => {
  for (const [version, candidate] of Object.entries(
    getPackumentVersions(packument)
  )) {
    const versionDocument = getObject(candidate);
    if (!versionDocument) {
      continue;
    }
    const name =
      typeof versionDocument.name === 'string'
        ? versionDocument.name
        : packageName;
    const resolvedVersion =
      typeof versionDocument.version === 'string'
        ? versionDocument.version
        : version;
    const expectedTarballName = createTarballFileName(name, resolvedVersion);
    const upstreamTarballName = getTarballNameFromUrl(
      getObject(versionDocument.dist)?.tarball
    );
    if (
      tarballName === expectedTarballName ||
      tarballName === upstreamTarballName
    ) {
      return {
        version: resolvedVersion,
        versionDocument,
      };
    }
  }
  return undefined;
};

const getPublishedTimeFromPackument = (
  packument: PackumentDocument,
  version: string
): string | undefined => {
  const time = getObject(packument.time);
  const published = time?.[version];
  return typeof published === 'string' ? published : undefined;
};

const hasRole = (
  request: AuthenticatedFastifyRequest,
  roles: string[]
): boolean => {
  if (!request.user) {
    return false;
  }
  return (
    roles.includes(request.user.role) ||
    (roles.includes('read') &&
      ['publish', 'admin'].includes(request.user.role)) ||
    (roles.includes('publish') && request.user.role === 'admin')
  );
};

const getBodyObject = (body: unknown): Record<string, any> =>
  body && typeof body === 'object' ? (body as Record<string, any>) : {};

const getDistTagsFromPublishBody = (
  body: Record<string, any>
): PackageDistTags => {
  const tags = body['dist-tags'];
  return tags && typeof tags === 'object' ? (tags as PackageDistTags) : {};
};

/**
 * Registers npm registry routes with Fastify.
 */
export const registerNpmRoutes = async (
  fastify: FastifyInstance,
  config: NpmRoutesConfig,
  locker: ReaderWriterLock
) => {
  const {
    metadataService,
    authService,
    userService,
    totpService,
    authConfig,
    packagesRoot,
    logger,
    urlResolver,
    proxyMetadataService,
    proxyService,
  } = config;
  const packageService = createPackageService(packagesRoot);
  const proxyPackageService = proxyService
    ? createPackageService(proxyService.packagesRoot)
    : undefined;
  const loginFlows = new Map<string, NpmLoginFlow>();

  const secondFactorForm = (message: string): string => `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>npm login verification</title></head>
  <body><main>
    <h1>Two-step authentication</h1>
    <p>${message}</p>
    <form method="post">
      <label>Authenticator or recovery code <input name="code" autocomplete="one-time-code" required maxlength="100" autofocus></label><br>
      <label><input name="recovery" type="checkbox">Use a recovery code</label><br>
      <button type="submit">Verify</button>
    </form>
  </main></body>
</html>`;

  const getBaseUrl = (request: FastifyRequest): string =>
    urlResolver.resolveUrl(request).baseUrl;

  const npmAuth = createNpmHybridAuthMiddleware(authConfig);
  const readPreHandler =
    authService.getAuthMode() === 'full' ? ([npmAuth] as any) : [];
  const writePreHandler =
    authService.getAuthMode() === 'none'
      ? []
      : ([
          npmAuth,
          async (request: FastifyRequest, reply: FastifyReply) => {
            if (!hasRole(request as AuthenticatedFastifyRequest, ['publish'])) {
              return reply
                .status(403)
                .send({ error: 'Publish permission required' });
            }
          },
        ] as any);

  fastify.get('/-/ping', async (_request, reply) => reply.send({ ok: true }));

  fastify.post('/-/npm/v1/security/advisories/bulk', async (_request, reply) =>
    reply.send({})
  );

  fastify.post('/-/npm/v1/security/audits/quick', async (_request, reply) =>
    reply.send({
      actions: [],
      advisories: {},
      muted: [],
      metadata: {
        vulnerabilities: {},
        dependencies: 0,
        devDependencies: 0,
        optionalDependencies: 0,
        totalDependencies: 0,
      },
      runId: randomUUID(),
    })
  );

  fastify.get(
    '/-/whoami',
    {
      preHandler:
        authService.getAuthMode() === 'none' ? [] : ([npmAuth] as any),
    },
    async (request, reply) => {
      const authRequest = request as AuthenticatedFastifyRequest;
      return reply.send({
        username: authRequest.user?.username ?? 'anonymous',
      });
    }
  );

  fastify.post('/-/v1/login', async (request, reply) => {
    const id = randomUUID();
    loginFlows.set(id, {
      id,
      createdAt: Date.now(),
    });

    const baseUrl = getBaseUrl(request);
    return reply.status(201).send({
      loginUrl: `${baseUrl}/npm-login/${id}`,
      doneUrl: `${baseUrl}/-/v1/login/${id}/done`,
    });
  });

  fastify.get('/-/v1/login/:id/done', async (request, reply) => {
    const { id } = request.params as { id: string };
    const flow = loginFlows.get(id);
    if (!flow || Date.now() - flow.createdAt > 10 * 60 * 1000) {
      loginFlows.delete(id);
      return reply.status(404).send({ error: 'Login flow not found' });
    }

    if (!flow.token) {
      return reply.status(202).header('Retry-After', '1').send({ done: false });
    }

    loginFlows.delete(id);
    return reply.send({
      token: flow.token,
      username: flow.username,
    });
  });

  fastify.get('/npm-login/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const flow = loginFlows.get(id);
    reply.header('Cache-Control', 'no-store');
    if (!flow || Date.now() - flow.createdAt > 10 * 60 * 1000) {
      totpService.cancel('', flow?.totpChallenge ?? '');
      loginFlows.delete(id);
      return reply.status(404).type('text/html').send('Login flow not found');
    }
    if (flow.totpChallenge) {
      return reply
        .type('text/html')
        .send(secondFactorForm('Enter the code from your authenticator app.'));
    }

    return reply.type('text/html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>npm login</title></head>
  <body>
    <main>
      <h1>npm login</h1>
      <form method="post" action="/npm-login/${encodeURIComponent(id)}">
        <label>Username <input name="username" autocomplete="username"></label><br>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label><br>
        <button type="submit">Login</button>
      </form>
    </main>
  </body>
</html>`);
  });

  fastify.post('/npm-login/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const flow = loginFlows.get(id);
    reply.header('Cache-Control', 'no-store');
    if (!flow || Date.now() - flow.createdAt > 10 * 60 * 1000) {
      totpService.cancel('', flow?.totpChallenge ?? '');
      loginFlows.delete(id);
      return reply.status(404).type('text/html').send('Login flow not found');
    }

    const body =
      typeof request.body === 'object' && request.body
        ? (request.body as Record<string, any>)
        : {};
    let username: string;
    try {
      if (flow.totpChallenge) {
        const result = await totpService.verifyLogin(
          flow.totpChallenge,
          String(body.code ?? ''),
          request.ip,
          body.recovery === true || body.recovery === 'on'
        );
        flow.totpChallenge = undefined;
        username = result.user.username;
      } else {
        username = String(body.username ?? '');
        const password = String(body.password ?? '');
        const user = await userService.validateCredentials(username, password);
        if (!user) {
          return reply
            .status(401)
            .type('text/html')
            .send('Invalid credentials');
        }
        if (user.totp && authService.getAuthMode() !== 'none') {
          flow.totpChallenge = totpService.beginLogin(user, false, request.ip);
          return reply
            .type('text/html')
            .send(
              secondFactorForm('Enter the code from your authenticator app.')
            );
        }
      }
    } catch (error) {
      const failure = error as { statusCode?: number; code?: string };
      if (failure.statusCode === 429) {
        return reply
          .status(429)
          .header('Retry-After', '600')
          .type('text/html')
          .send('Too many attempts. Try again in ten minutes.');
      }
      if (failure.code === 'TOTP_EXPIRED') {
        flow.totpChallenge = undefined;
        return reply
          .status(400)
          .type('text/html')
          .send('Verification expired. Reload this page to sign in again.');
      }
      if (failure.statusCode === 400) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            secondFactorForm(
              'The code is incorrect or has already been used. Try a new code.'
            )
          );
      }
      logger.error(`npm login verification failed: ${error}`);
      return reply
        .status(500)
        .type('text/html')
        .send('Unable to complete verification.');
    }

    const tokenResult = await userService.addNpmToken(
      username,
      `npm web login ${new Date().toISOString()}`
    );
    if (!tokenResult) {
      return reply.status(404).type('text/html').send('User not found');
    }

    flow.token = tokenResult.token;
    flow.username = username;
    return reply.type('text/html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>npm login complete</title></head>
  <body><main><h1>Login complete</h1><p>You can close this window.</p></main></body>
</html>`);
  });

  fastify.put('/-/user/*', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const routePath = (request.params as { '*': string })['*'];
    const routeUsername = routePath.replace(/^org\.couchdb\.user:/, '');
    const body = getBodyObject(request.body);
    const username = String(body.name ?? decodePackageName(routeUsername));
    const password = String(body.password ?? '');
    const user = await userService.validateCredentials(username, password);
    if (!user) {
      return reply.status(401).send({
        error: 'Invalid credentials',
        reason: 'Username or password is incorrect',
      });
    }

    if (user.totp && authService.getAuthMode() !== 'none') {
      const otp = request.headers['npm-otp'];
      if (typeof otp !== 'string' || !otp) {
        return reply.status(401).header('WWW-Authenticate', 'OTP').send({
          error: 'EOTP',
          reason: 'A one-time password is required',
        });
      }
      let challenge: string | undefined;
      try {
        challenge = totpService.beginLogin(user, false, request.ip);
        // npm sends both authenticator and recovery codes through npm-otp.
        await totpService.verifyLogin(
          challenge,
          otp,
          request.ip,
          !/^\d{6}$/.test(otp)
        );
      } catch (error) {
        const failure = error as { statusCode?: number };
        if (failure.statusCode === 429) {
          return reply.status(429).header('Retry-After', '600').send({
            error: 'TOTP_RATE_LIMITED',
            reason: 'Too many verification attempts',
          });
        }
        if (failure.statusCode === 400) {
          return reply.status(401).header('WWW-Authenticate', 'OTP').send({
            error: 'EOTP',
            reason: 'The one-time password is invalid or has already been used',
          });
        }
        logger.error(`npm login verification failed: ${error}`);
        return reply.status(500).send({ error: 'TOTP_STORAGE_ERROR' });
      } finally {
        totpService.cancel('', challenge ?? '');
      }
    }

    const tokenResult = await userService.addNpmToken(
      username,
      `npm legacy login ${new Date().toISOString()}`
    );
    if (!tokenResult) {
      return reply.status(404).send({ error: 'User not found' });
    }

    return reply.send({
      ok: true,
      id: `org.couchdb.user:${username}`,
      rev: tokenResult.key,
      token: tokenResult.token,
      username,
    });
  });

  fastify.get(
    '/-/v1/search',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const query = request.query as Record<string, any>;
      const text = String(query.text ?? '').toLowerCase();
      const from = Number.parseInt(String(query.from ?? '0'), 10);
      const size = Number.parseInt(String(query.size ?? '20'), 10);
      const baseUrl = getBaseUrl(request);

      const objects = metadataService
        .getAllPackageIds()
        .map((packageName) =>
          metadataService.getLatestPackageEntry(packageName)
        )
        .filter(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined
        )
        .filter((entry) => {
          if (!text) {
            return true;
          }
          const manifest = entry.metadata.manifest;
          return (
            entry.metadata.name.toLowerCase().includes(text) ||
            String(manifest.description ?? '')
              .toLowerCase()
              .includes(text) ||
            (manifest.keywords ?? []).some((keyword) =>
              keyword.toLowerCase().includes(text)
            )
          );
        })
        .map((entry) => ({
          package: {
            name: entry.metadata.name,
            version: entry.metadata.version,
            description: entry.metadata.manifest.description ?? '',
            keywords: entry.metadata.manifest.keywords ?? [],
            date: entry.metadata.published,
            links: {
              npm: `${baseUrl}/${encodePackageNameForPath(entry.metadata.name)}`,
              homepage: entry.metadata.manifest.homepage,
              repository: entry.metadata.manifest.repository,
              bugs: entry.metadata.manifest.bugs,
            },
            publisher: entry.metadata.manifest.author,
            maintainers: entry.metadata.manifest.maintainers ?? [],
          },
          score: {
            final: 1,
            detail: {
              quality: 1,
              popularity: 0,
              maintenance: 1,
            },
          },
          searchScore: 1,
        }));

      return reply.send({
        objects: objects.slice(from, from + size),
        total: objects.length,
        time: new Date().toISOString(),
      });
    }
  );

  const sendPackument = async (
    request: FastifyRequest,
    reply: FastifyReply,
    packageName: string
  ) => {
    const localPackument = createPackument(
      getBaseUrl(request),
      packageName,
      metadataService
    );
    const proxyCachePackument = proxyMetadataService
      ? createPackument(getBaseUrl(request), packageName, proxyMetadataService)
      : undefined;

    let upstreamPackument: PackumentDocument | undefined = undefined;
    let upstreamError: unknown = undefined;
    if (proxyService) {
      try {
        upstreamPackument = createProxiedPackument(
          getBaseUrl(request),
          packageName,
          await proxyService.fetchPackument(packageName, request.abortSignal)
        );
      } catch (error) {
        upstreamError = error;
      }
    }

    const packument = mergePackuments(packageName, [
      upstreamPackument,
      proxyCachePackument,
      localPackument,
    ]);
    if (packument) {
      return reply.send(packument);
    }

    if (upstreamError && isNpmProxyError(upstreamError)) {
      return reply
        .status(upstreamError.statusCode)
        .send({ error: upstreamError.message });
    }
    if (upstreamError) {
      return reply.status(502).send({ error: 'Upstream registry error' });
    }

    if (!packument) {
      return reply.status(404).send({ error: 'Package not found' });
    }
  };

  const sendVersion = async (
    request: FastifyRequest,
    reply: FastifyReply,
    packageName: string,
    versionOrTag: string
  ) => {
    const distTags = metadataService.getDistTags(packageName);
    const version = distTags[versionOrTag] ?? versionOrTag;
    const metadata = metadataService.getPackageVersion(packageName, version);
    if (metadata) {
      return reply.send(
        createVersionDocument({
          ...metadata,
          tarballUrl: `${getBaseUrl(request)}/${encodePackageNameForPath(
            metadata.name
          )}/-/${encodeURIComponent(metadata.tarballName)}`,
        })
      );
    }

    if (proxyMetadataService) {
      const proxyDistTags = proxyMetadataService.getDistTags(packageName);
      const proxyVersion = proxyDistTags[versionOrTag] ?? versionOrTag;
      const proxyMetadata = proxyMetadataService.getPackageVersion(
        packageName,
        proxyVersion
      );
      if (proxyMetadata) {
        return reply.send(
          createVersionDocument({
            ...proxyMetadata,
            tarballUrl: `${getBaseUrl(request)}/${encodePackageNameForPath(
              proxyMetadata.name
            )}/-/${encodeURIComponent(proxyMetadata.tarballName)}`,
          })
        );
      }
    }

    if (proxyService) {
      try {
        const upstreamPackument = createProxiedPackument(
          getBaseUrl(request),
          packageName,
          await proxyService.fetchPackument(packageName, request.abortSignal)
        );
        const upstreamVersion = upstreamPackument
          ? getVersionDocumentFromPackument(upstreamPackument, versionOrTag)
          : undefined;
        if (upstreamVersion) {
          return reply.send(upstreamVersion.versionDocument);
        }
      } catch (error) {
        if (isNpmProxyError(error)) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        return reply.status(502).send({ error: 'Upstream registry error' });
      }
    }

    return reply.status(404).send({ error: 'Package version not found' });
  };

  const streamPackageTarball = async (
    request: FastifyRequest,
    reply: FastifyReply,
    service: ReturnType<typeof createPackageService>,
    packageName: string,
    metadata: PackageVersionMetadata,
    tarballName: string
  ) => {
    const tarballPath = await service.getTarballFilePath(
      packageName,
      metadata.version,
      tarballName
    );
    if (!tarballPath) {
      return false;
    }

    await streamFile(
      logger,
      locker,
      tarballPath,
      reply,
      {
        contentType: 'application/octet-stream',
        contentDisposition: `attachment; filename="${tarballName}"`,
      },
      request.abortSignal
    );
    return true;
  };

  const getTarballMetadata = (
    service: MetadataService,
    packageName: string,
    tarballName: string
  ): PackageVersionMetadata | undefined => {
    const versions = service.getPackageMetadata(packageName);
    return versions.find((metadata) => metadata.tarballName === tarballName);
  };

  const fetchAndCacheUpstreamTarball = async (
    request: FastifyRequest,
    reply: FastifyReply,
    packageName: string,
    tarballName: string
  ) => {
    if (!proxyService || !proxyPackageService) {
      return false;
    }

    try {
      const upstreamRawPackument = await proxyService.fetchPackument(
        packageName,
        request.abortSignal
      );
      const upstreamVersion = getVersionDocumentByTarballName(
        upstreamRawPackument,
        packageName,
        tarballName
      );
      if (!upstreamVersion) {
        return false;
      }

      const metadata = await proxyService.cacheTarball({
        packageName,
        version: upstreamVersion.version,
        versionDocument: upstreamVersion.versionDocument,
        distTags: getPackumentDistTags(upstreamRawPackument),
        published: getPublishedTimeFromPackument(
          upstreamRawPackument,
          upstreamVersion.version
        ),
        baseUrl: getBaseUrl(request),
        signal: request.abortSignal,
      });
      return streamPackageTarball(
        request,
        reply,
        proxyPackageService,
        packageName,
        metadata,
        metadata.tarballName
      );
    } catch (error) {
      if (isNpmProxyError(error)) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.status(502).send({ error: 'Upstream registry error' });
    }
  };

  const sendTarball = async (
    request: FastifyRequest,
    reply: FastifyReply,
    packageName: string,
    tarballName: string
  ) => {
    const expectedEntry = getTarballMetadata(
      metadataService,
      packageName,
      tarballName
    );
    if (
      expectedEntry &&
      (await streamPackageTarball(
        request,
        reply,
        packageService,
        packageName,
        expectedEntry,
        tarballName
      ))
    ) {
      return;
    }

    const proxyCacheEntry = proxyMetadataService
      ? getTarballMetadata(proxyMetadataService, packageName, tarballName)
      : undefined;
    if (
      proxyCacheEntry &&
      proxyPackageService &&
      (await streamPackageTarball(
        request,
        reply,
        proxyPackageService,
        packageName,
        proxyCacheEntry,
        tarballName
      ))
    ) {
      return;
    }

    const upstreamHandled = await fetchAndCacheUpstreamTarball(
      request,
      reply,
      packageName,
      tarballName
    );
    if (upstreamHandled) {
      return;
    }

    return reply.status(404).send({ error: 'Tarball not found' });
  };

  const publishFromNpmClient = async (
    request: FastifyRequest,
    reply: FastifyReply,
    packageName: string
  ) => {
    if (!isValidPackageName(packageName)) {
      return reply.status(400).send({ error: 'Invalid package name' });
    }

    const body = getBodyObject(request.body);
    const attachment = body._attachments
      ? Object.values(body._attachments)[0]
      : undefined;
    if (!attachment || typeof attachment !== 'object') {
      return reply.status(400).send({ error: 'Missing package attachment' });
    }

    const data = (attachment as any).data;
    if (typeof data !== 'string') {
      return reply.status(400).send({ error: 'Missing package data' });
    }

    const tarball = Buffer.from(data, 'base64');
    const result = await publishNpmTarball({
      packagesRoot,
      metadataService,
      tarball,
      baseUrl: getBaseUrl(request),
      logger,
      policy: 'error',
      distTags: getDistTagsFromPublishBody(body),
      expectedPackageName: packageName,
      signal: request.abortSignal,
    });

    if (result.action === 'error') {
      return reply.status(409).send({ error: result.message });
    }

    return reply.status(201).send({
      ok: true,
      id: result.name,
      rev: `${result.name}@${result.version}`,
    });
  };

  const getDistTags = async (
    _request: FastifyRequest,
    reply: FastifyReply,
    packageName: string
  ) => {
    if (metadataService.getPackageMetadata(packageName).length === 0) {
      return reply.status(404).send({ error: 'Package not found' });
    }
    return reply.send(metadataService.getDistTags(packageName));
  };

  const putDistTag = async (
    request: FastifyRequest,
    reply: FastifyReply,
    packageName: string,
    tag: string
  ) => {
    const body = request.body;
    const version =
      typeof body === 'string'
        ? body
        : typeof body === 'object' && body
          ? String((body as Record<string, any>).version ?? '')
          : '';
    if (!version) {
      return reply.status(400).send({ error: 'Version is required' });
    }
    await metadataService.updateDistTag(packageName, tag, version);
    return reply.send({ ok: true });
  };

  const deleteDistTag = async (
    _request: FastifyRequest,
    reply: FastifyReply,
    packageName: string,
    tag: string
  ) => {
    await metadataService.deleteDistTag(packageName, tag);
    return reply.send({ ok: true });
  };

  fastify.get(
    '/-/package/:name/dist-tags',
    { preHandler: readPreHandler },
    async (request, reply) =>
      getDistTags(
        request,
        reply,
        decodePackageName((request.params as { name: string }).name)
      )
  );
  fastify.get(
    '/-/package/@:scope/:name/dist-tags',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const { scope, name } = request.params as { scope: string; name: string };
      return getDistTags(request, reply, buildPackageName(scope, name));
    }
  );
  fastify.put(
    '/-/package/:name/dist-tags/:tag',
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { name, tag } = request.params as { name: string; tag: string };
      return putDistTag(request, reply, decodePackageName(name), tag);
    }
  );
  fastify.put(
    '/-/package/@:scope/:name/dist-tags/:tag',
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { scope, name, tag } = request.params as {
        scope: string;
        name: string;
        tag: string;
      };
      return putDistTag(request, reply, buildPackageName(scope, name), tag);
    }
  );
  fastify.delete(
    '/-/package/:name/dist-tags/:tag',
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { name, tag } = request.params as { name: string; tag: string };
      return deleteDistTag(request, reply, decodePackageName(name), tag);
    }
  );
  fastify.delete(
    '/-/package/@:scope/:name/dist-tags/:tag',
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { scope, name, tag } = request.params as {
        scope: string;
        name: string;
        tag: string;
      };
      return deleteDistTag(request, reply, buildPackageName(scope, name), tag);
    }
  );

  fastify.get(
    '/:name',
    { preHandler: readPreHandler },
    async (request, reply) =>
      sendPackument(
        request,
        reply,
        decodePackageName((request.params as { name: string }).name)
      )
  );
  fastify.get(
    '/@:scope/:name',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const { scope, name } = request.params as { scope: string; name: string };
      return sendPackument(request, reply, buildPackageName(scope, name));
    }
  );
  fastify.get(
    '/:name/:versionOrTag',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const { name, versionOrTag } = request.params as {
        name: string;
        versionOrTag: string;
      };
      return sendVersion(request, reply, decodePackageName(name), versionOrTag);
    }
  );
  fastify.get(
    '/@:scope/:name/:versionOrTag',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const { scope, name, versionOrTag } = request.params as {
        scope: string;
        name: string;
        versionOrTag: string;
      };
      return sendVersion(
        request,
        reply,
        buildPackageName(scope, name),
        versionOrTag
      );
    }
  );
  fastify.get(
    '/:name/-/:tarball',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const { name, tarball } = request.params as {
        name: string;
        tarball: string;
      };
      return sendTarball(
        request,
        reply,
        decodePackageName(name),
        decodePackageName(tarball)
      );
    }
  );
  fastify.get(
    '/@:scope/:name/-/:tarball',
    { preHandler: readPreHandler },
    async (request, reply) => {
      const { scope, name, tarball } = request.params as {
        scope: string;
        name: string;
        tarball: string;
      };
      return sendTarball(
        request,
        reply,
        buildPackageName(scope, name),
        decodePackageName(tarball)
      );
    }
  );
  fastify.put(
    '/:name',
    { preHandler: writePreHandler },
    async (request, reply) =>
      publishFromNpmClient(
        request,
        reply,
        decodePackageName((request.params as { name: string }).name)
      )
  );
  fastify.put(
    '/@:scope/:name',
    { preHandler: writePreHandler },
    async (request, reply) => {
      const { scope, name } = request.params as { scope: string; name: string };
      return publishFromNpmClient(
        request,
        reply,
        buildPackageName(scope, name)
      );
    }
  );

  logger.info('npm registry routes registered successfully');
};
