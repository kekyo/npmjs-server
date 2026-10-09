// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import fs from 'fs/promises';
import path from 'path';
import type { DuplicatePackagePolicy, Logger } from '../types.ts';
import {
  calculateDist,
  createTarballFileName,
  encodePackageNameForPath,
  extractNpmTarball,
  isValidPackageName,
  packageNameToPathSegments,
} from '../utils/npmPackage.ts';
import type {
  MetadataService,
  PackageDistTags,
  PackageEntry,
} from './metadataService.ts';

/**
 * Result of publishing an npm tarball.
 */
export interface PublishNpmPackageResult {
  action: 'added' | 'overwritten' | 'ignored' | 'error';
  name: string;
  version: string;
  message: string;
}

/**
 * Creates a package entry from a tarball.
 * @param tarball - Package tarball bytes
 * @param baseUrl - Registry base URL
 * @param signal - Optional abort signal
 * @returns Package entry
 */
export const createPackageEntryFromTarball = async (
  tarball: Buffer,
  baseUrl: string,
  signal?: AbortSignal
): Promise<PackageEntry> => {
  const { manifest, readme } = await extractNpmTarball(tarball, signal);
  if (!isValidPackageName(manifest.name)) {
    throw new Error(`Invalid package name: ${manifest.name}`);
  }

  const tarballName = createTarballFileName(manifest.name, manifest.version);
  const dist = calculateDist(tarball);
  const tarballUrl = `${baseUrl.replace(/\/$/, '')}/${encodePackageNameForPath(
    manifest.name
  )}/-/${encodeURIComponent(tarballName)}`;
  const manifestWithDist = {
    ...manifest,
    readme: manifest.readme ?? readme,
    dist: {
      ...(typeof manifest.dist === 'object' ? manifest.dist : {}),
      tarball: tarballUrl,
      shasum: dist.shasum,
      integrity: dist.integrity,
    },
  };

  return {
    metadata: {
      name: manifest.name,
      version: manifest.version,
      manifest: manifestWithDist,
      readme: manifest.readme ?? readme,
      published: new Date().toISOString(),
      shasum: dist.shasum,
      integrity: dist.integrity,
      tarballName,
      tarballUrl,
    },
    storage: {
      packagePathSegments: packageNameToPathSegments(manifest.name),
      version: manifest.version,
      tarballName,
    },
  };
};

/**
 * Publishes an npm tarball to the filesystem-backed registry.
 * @param input - Publish input
 * @returns Publish result
 */
export const publishNpmTarball = async (input: {
  packagesRoot: string;
  metadataService: MetadataService;
  tarball: Buffer;
  baseUrl: string;
  logger: Logger;
  policy?: DuplicatePackagePolicy;
  distTags?: PackageDistTags;
  expectedPackageName?: string;
  signal?: AbortSignal;
}): Promise<PublishNpmPackageResult> => {
  const {
    packagesRoot,
    metadataService,
    tarball,
    baseUrl,
    logger,
    policy = 'error',
    distTags,
    expectedPackageName,
    signal,
  } = input;

  const entry = await createPackageEntryFromTarball(tarball, baseUrl, signal);
  if (expectedPackageName && expectedPackageName !== entry.metadata.name) {
    throw new Error(
      `Package name mismatch: URL is ${expectedPackageName}, tarball is ${entry.metadata.name}`
    );
  }

  const existing = metadataService.getPackageEntry(
    entry.metadata.name,
    entry.metadata.version
  );
  if (existing && policy === 'error') {
    return {
      action: 'error',
      name: entry.metadata.name,
      version: entry.metadata.version,
      message: `Package ${entry.metadata.name}@${entry.metadata.version} already exists`,
    };
  }
  if (existing && policy === 'ignore') {
    return {
      action: 'ignored',
      name: entry.metadata.name,
      version: entry.metadata.version,
      message: 'Package already exists and was ignored',
    };
  }

  const versionPath = path.join(
    packagesRoot,
    ...entry.storage.packagePathSegments,
    entry.metadata.version
  );
  await fs.mkdir(versionPath, { recursive: true });
  await fs.writeFile(
    path.join(versionPath, entry.storage.tarballName),
    tarball
  );

  const addResult = await metadataService.addPackageEntry(
    entry,
    policy,
    distTags
  );
  if (addResult.action === 'error') {
    return {
      action: 'error',
      name: entry.metadata.name,
      version: entry.metadata.version,
      message:
        addResult.message ??
        `Package ${entry.metadata.name}@${entry.metadata.version} already exists`,
    };
  }

  logger.info(
    `npm package ${addResult.action}: ${entry.metadata.name}@${entry.metadata.version}`
  );

  return {
    action: addResult.action,
    name: entry.metadata.name,
    version: entry.metadata.version,
    message:
      addResult.action === 'overwritten'
        ? 'Package uploaded successfully (replaced existing version)'
        : 'Package uploaded successfully',
  };
};
