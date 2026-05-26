// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Logger } from '../types';
import { createPackageEntryFromTarball } from './npmPublishService';
import {
  MetadataService,
  PackageDistTags,
  PackageEntry,
  PackageVersionMetadata,
} from './metadataService';

const defaultFetchTimeoutMs = 30_000;

/**
 * Error returned by the upstream npm proxy.
 */
export interface NpmProxyError extends Error {
  /**
   * HTTP status code to return to the npm client.
   */
  statusCode: number;
  /**
   * Stable proxy error category.
   */
  proxyCode: 'not-found' | 'bad-gateway' | 'gateway-timeout';
}

/**
 * Upstream npm proxy service.
 */
export interface NpmProxyService {
  /**
   * Root directory used for proxy cache files.
   */
  readonly packagesRoot: string;
  /**
   * Normalized upstream registry URL.
   */
  readonly upstreamRegistry: string;
  /**
   * Fetches a package packument from the upstream registry.
   */
  readonly fetchPackument: (
    packageName: string,
    signal?: AbortSignal
  ) => Promise<Record<string, any>>;
  /**
   * Downloads, verifies, and stores an upstream tarball in the proxy cache.
   */
  readonly cacheTarball: (
    input: CacheTarballInput
  ) => Promise<PackageVersionMetadata>;
}

/**
 * Input used when downloading and caching an upstream tarball.
 */
export interface CacheTarballInput {
  /**
   * Expected npm package name.
   */
  packageName: string;
  /**
   * Expected npm package version.
   */
  version: string;
  /**
   * Upstream version document containing dist metadata.
   */
  versionDocument: Record<string, any>;
  /**
   * Upstream dist-tags to persist when they point at cached versions.
   */
  distTags: PackageDistTags;
  /**
   * Base URL used when rewriting cached tarball metadata.
   */
  baseUrl: string;
  /**
   * Published timestamp from the upstream packument, when available.
   */
  published?: string;
  /**
   * Abort signal for client disconnect or request cancellation.
   */
  signal?: AbortSignal;
}

/**
 * Configuration for npm proxy service creation.
 */
export interface NpmProxyServiceConfig {
  /**
   * Root directory used for proxy cache files.
   */
  packagesRoot: string;
  /**
   * Upstream npm registry URL.
   */
  upstreamRegistry: string;
  /**
   * Metadata service dedicated to the proxy cache.
   */
  metadataService: MetadataService;
  /**
   * Logger instance.
   */
  logger: Logger;
  /**
   * Upstream fetch timeout in milliseconds.
   */
  fetchTimeoutMs?: number;
}

/**
 * Normalizes npm registry URLs.
 * @param upstreamRegistry - Registry URL
 * @returns Normalized registry URL without trailing slashes
 */
export const normalizeNpmRegistryUrl = (upstreamRegistry: string): string => {
  const url = new URL(upstreamRegistry);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Proxy upstream registry must use http or https');
  }
  return url.toString().replace(/\/+$/, '');
};

/**
 * Checks whether an error came from the npm proxy service.
 * @param error - Unknown error value
 * @returns True when the error has proxy status information
 */
export const isNpmProxyError = (error: unknown): error is NpmProxyError =>
  error instanceof Error &&
  typeof (error as Partial<NpmProxyError>).statusCode === 'number' &&
  typeof (error as Partial<NpmProxyError>).proxyCode === 'string';

const createNpmProxyError = (
  statusCode: number,
  proxyCode: NpmProxyError['proxyCode'],
  message: string
): NpmProxyError =>
  Object.assign(new Error(message), {
    statusCode,
    proxyCode,
  });

const createTimeoutSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortHandler = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
    },
  };
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> => {
  const timeoutSignal = createTimeoutSignal(signal, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: timeoutSignal.signal,
    });
  } catch (error) {
    if (timeoutSignal.didTimeout()) {
      throw createNpmProxyError(
        504,
        'gateway-timeout',
        `Upstream registry request timed out: ${url}`
      );
    }
    throw createNpmProxyError(
      502,
      'bad-gateway',
      `Upstream registry request failed: ${error}`
    );
  } finally {
    timeoutSignal.cleanup();
  }
};

const getObject = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const getDistObject = (
  versionDocument: Record<string, any>
): Record<string, any> | undefined => getObject(versionDocument.dist);

const getUpstreamTarballUrl = (
  versionDocument: Record<string, any>
): string => {
  const tarballUrl = getDistObject(versionDocument)?.tarball;
  if (typeof tarballUrl !== 'string' || tarballUrl.length === 0) {
    throw createNpmProxyError(
      502,
      'bad-gateway',
      'Upstream package version does not contain dist.tarball'
    );
  }

  try {
    const url = new URL(tarballUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    return url.toString();
  } catch {
    throw createNpmProxyError(
      502,
      'bad-gateway',
      `Upstream package version has invalid dist.tarball: ${tarballUrl}`
    );
  }
};

const ensureChecksumMatches = (
  entry: PackageEntry,
  versionDocument: Record<string, any>
): void => {
  const dist = getDistObject(versionDocument);
  const expectedShasum = dist?.shasum;
  if (
    typeof expectedShasum === 'string' &&
    expectedShasum.length > 0 &&
    expectedShasum !== entry.metadata.shasum
  ) {
    throw createNpmProxyError(
      502,
      'bad-gateway',
      `Upstream tarball shasum mismatch for ${entry.metadata.name}@${entry.metadata.version}`
    );
  }

  const expectedIntegrity = dist?.integrity;
  if (
    typeof expectedIntegrity === 'string' &&
    expectedIntegrity.length > 0 &&
    !expectedIntegrity.split(/\s+/).includes(entry.metadata.integrity)
  ) {
    throw createNpmProxyError(
      502,
      'bad-gateway',
      `Upstream tarball integrity mismatch for ${entry.metadata.name}@${entry.metadata.version}`
    );
  }
};

const mergeUpstreamVersionDocument = (
  entry: PackageEntry,
  versionDocument: Record<string, any>
): PackageEntry => {
  const upstreamDist = getDistObject(versionDocument) ?? {};
  const readme =
    typeof versionDocument.readme === 'string'
      ? versionDocument.readme
      : entry.metadata.readme;

  return {
    ...entry,
    metadata: {
      ...entry.metadata,
      readme,
      manifest: {
        ...versionDocument,
        name: entry.metadata.name,
        version: entry.metadata.version,
        readme,
        dist: {
          ...upstreamDist,
          tarball: entry.metadata.tarballUrl,
          shasum: entry.metadata.shasum,
          integrity: entry.metadata.integrity,
        },
      },
    },
  };
};

const getPackageVersionKey = (packageName: string, version: string): string =>
  `${packageName.toLowerCase()}@${version}`;

const getPublishedTime = (
  input: CacheTarballInput,
  entry: PackageEntry
): string => {
  const time = input.published ?? input.versionDocument.time;
  return typeof time === 'string' && time.length > 0
    ? time
    : entry.metadata.published;
};

/**
 * Creates an npm upstream proxy service.
 * @param config - Proxy service configuration
 * @returns Configured npm proxy service
 */
export const createNpmProxyService = (
  config: NpmProxyServiceConfig
): NpmProxyService => {
  const {
    packagesRoot,
    metadataService,
    logger,
    fetchTimeoutMs = defaultFetchTimeoutMs,
  } = config;
  const upstreamRegistry = normalizeNpmRegistryUrl(config.upstreamRegistry);
  const pendingDownloads = new Map<string, Promise<PackageVersionMetadata>>();

  const fetchPackument = async (
    packageName: string,
    signal?: AbortSignal
  ): Promise<Record<string, any>> => {
    const url = `${upstreamRegistry}/${encodeURIComponent(packageName)}`;
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'npmjs-server',
        },
      },
      signal,
      fetchTimeoutMs
    );

    if (response.status === 404) {
      throw createNpmProxyError(
        404,
        'not-found',
        `Upstream package not found: ${packageName}`
      );
    }
    if (!response.ok) {
      throw createNpmProxyError(
        502,
        'bad-gateway',
        `Upstream registry returned ${response.status} for ${packageName}`
      );
    }

    const packument = getObject(await response.json());
    if (!packument || !getObject(packument.versions)) {
      throw createNpmProxyError(
        502,
        'bad-gateway',
        `Upstream registry returned invalid packument for ${packageName}`
      );
    }

    return packument;
  };

  const downloadTarballToFile = async (
    tarballUrl: string,
    tmpPath: string,
    signal?: AbortSignal
  ): Promise<void> => {
    const response = await fetchWithTimeout(
      tarballUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'npmjs-server',
        },
      },
      signal,
      fetchTimeoutMs
    );

    if (response.status === 404) {
      throw createNpmProxyError(
        404,
        'not-found',
        `Upstream tarball not found: ${tarballUrl}`
      );
    }
    if (!response.ok || !response.body) {
      throw createNpmProxyError(
        502,
        'bad-gateway',
        `Upstream registry returned invalid tarball response: ${response.status}`
      );
    }

    await pipeline(
      Readable.fromWeb(response.body as any),
      createWriteStream(tmpPath),
      { signal }
    );
  };

  const cacheTarballCore = async (
    input: CacheTarballInput
  ): Promise<PackageVersionMetadata> => {
    const existing = metadataService.getPackageEntry(
      input.packageName,
      input.version
    );
    if (existing) {
      return existing.metadata;
    }

    const tmpDir = path.join(packagesRoot, '.tmp');
    const tmpPath = path.join(
      tmpDir,
      `${input.packageName.replace(/\//g, '_')}-${input.version}-${randomUUID()}.tgz`
    );
    let versionPath: string | undefined = undefined;
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const tarballUrl = getUpstreamTarballUrl(input.versionDocument);
      await downloadTarballToFile(tarballUrl, tmpPath, input.signal);

      const tarball = await fs.readFile(tmpPath);
      let entry = await createPackageEntryFromTarball(
        tarball,
        input.baseUrl,
        input.signal
      );
      if (
        entry.metadata.name !== input.packageName ||
        entry.metadata.version !== input.version
      ) {
        throw createNpmProxyError(
          502,
          'bad-gateway',
          `Upstream tarball package mismatch: expected ${input.packageName}@${input.version}, got ${entry.metadata.name}@${entry.metadata.version}`
        );
      }

      ensureChecksumMatches(entry, input.versionDocument);
      entry = mergeUpstreamVersionDocument(entry, input.versionDocument);
      entry.metadata.published = getPublishedTime(input, entry);

      versionPath = path.join(
        packagesRoot,
        ...entry.storage.packagePathSegments,
        entry.metadata.version
      );
      const finalTarballPath = path.join(
        versionPath,
        entry.storage.tarballName
      );
      await fs.mkdir(versionPath, { recursive: true });
      await fs.rename(tmpPath, finalTarballPath);

      const addResult = await metadataService.addPackageEntry(
        entry,
        'ignore',
        input.distTags
      );
      const cached = metadataService.getPackageVersion(
        input.packageName,
        input.version
      );
      if (!cached) {
        throw createNpmProxyError(
          502,
          'bad-gateway',
          `Failed to cache upstream package ${input.packageName}@${input.version}: ${addResult.action}`
        );
      }

      logger.info(
        `npm proxy package cached: ${input.packageName}@${input.version}`
      );
      return cached;
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      if (versionPath) {
        await fs.rm(versionPath, { recursive: true, force: true });
      }
      throw error;
    }
  };

  return {
    packagesRoot,
    upstreamRegistry,
    fetchPackument,
    cacheTarball: async (
      input: CacheTarballInput
    ): Promise<PackageVersionMetadata> => {
      const existing = metadataService.getPackageVersion(
        input.packageName,
        input.version
      );
      if (existing) {
        return existing;
      }

      const key = getPackageVersionKey(input.packageName, input.version);
      const pending = pendingDownloads.get(key);
      if (pending) {
        return pending;
      }

      const download = cacheTarballCore(input).finally(() => {
        pendingDownloads.delete(key);
      });
      pendingDownloads.set(key, download);
      return download;
    },
  };
};
