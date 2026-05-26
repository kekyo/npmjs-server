// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import { createReaderWriterLock } from 'async-primitives';
import { Logger, DuplicatePackagePolicy } from '../types';
import {
  createTarballFileName,
  encodePackageNameForPath,
  NpmPackageManifest,
  packageNameToPathSegments,
} from '../utils/npmPackage';

/**
 * Metadata stored for a single npm package version.
 */
export interface PackageVersionMetadata {
  name: string;
  version: string;
  manifest: NpmPackageManifest;
  readme?: string;
  published: string;
  shasum: string;
  integrity: string;
  tarballName: string;
  tarballUrl: string;
}

/**
 * Storage information for a single package version.
 */
export interface PackageStorage {
  packagePathSegments: string[];
  version: string;
  tarballName: string;
}

/**
 * Combined package metadata and storage information.
 */
export interface PackageEntry {
  metadata: PackageVersionMetadata;
  storage: PackageStorage;
}

/**
 * npm dist-tags for a package.
 */
export type PackageDistTags = Record<string, string>;

/**
 * Service interface for managing npm package metadata and cache.
 */
export interface MetadataService {
  readonly initialize: () => Promise<void>;
  readonly getPackageMetadata: (
    packageName: string
  ) => PackageVersionMetadata[];
  readonly getPackageVersion: (
    packageName: string,
    version: string
  ) => PackageVersionMetadata | undefined;
  readonly getPackageEntry: (
    packageName: string,
    version: string
  ) => PackageEntry | undefined;
  readonly getLatestPackageEntry: (
    packageName: string
  ) => PackageEntry | undefined;
  readonly getAllPackageIds: () => string[];
  readonly getDistTags: (packageName: string) => PackageDistTags;
  readonly updateDistTag: (
    packageName: string,
    tag: string,
    version: string
  ) => Promise<void>;
  readonly deleteDistTag: (packageName: string, tag: string) => Promise<void>;
  readonly updateBaseUrl: (baseUrl: string) => Promise<void>;
  readonly addPackageEntry: (
    entry: PackageEntry,
    policy?: DuplicatePackagePolicy,
    distTags?: PackageDistTags
  ) => Promise<{
    action: 'added' | 'overwritten' | 'ignored' | 'error';
    message?: string;
  }>;
}

/**
 * Creates a metadata service instance for npm packages.
 * @param packagesRoot - Root directory containing package files
 * @param baseUrl - Base URL for tarball URLs
 * @param logger - Logger instance
 * @returns Configured metadata service instance
 */
export const createMetadataService = (
  packagesRoot: string = './packages',
  baseUrl: string = '',
  logger: Logger
): MetadataService => {
  const packagesCache = new Map<string, PackageEntry[]>();
  const distTagsCache = new Map<string, PackageDistTags>();
  let currentBaseUrl = baseUrl.replace(/\/$/, '');
  const cacheLock = createReaderWriterLock();

  const normalizeKey = (packageName: string): string =>
    packageName.toLowerCase();

  const buildTarballUrl = (packageName: string, tarballName: string): string =>
    `${currentBaseUrl}/${encodePackageNameForPath(packageName)}/-/${encodeURIComponent(tarballName)}`;

  const getPackageRootPath = (packageName: string): string =>
    path.join(packagesRoot, ...packageNameToPathSegments(packageName));

  const filterExistingDistTags = (
    entries: PackageEntry[],
    distTags: PackageDistTags
  ): PackageDistTags =>
    Object.fromEntries(
      Object.entries(distTags).filter(([, version]) =>
        entries.some((entry) => entry.metadata.version === version)
      )
    );

  const getComputedLatestVersion = (
    entries: readonly PackageEntry[]
  ): string | undefined => entries[0]?.metadata.version;

  const withComputedLatestDistTag = (
    entries: PackageEntry[],
    distTags: PackageDistTags
  ): PackageDistTags => {
    const filteredTags = filterExistingDistTags(entries, distTags);
    const latest = getComputedLatestVersion(entries);
    return latest ? { latest, ...filteredTags } : filteredTags;
  };

  const getPersistableDistTags = (
    entries: PackageEntry[],
    distTags: PackageDistTags
  ): PackageDistTags => {
    const filteredTags = filterExistingDistTags(entries, distTags);
    const computedLatest = getComputedLatestVersion(entries);
    return Object.fromEntries(
      Object.entries(filteredTags).filter(
        ([tag, version]) => tag !== 'latest' || version !== computedLatest
      )
    );
  };

  const loadDistTags = async (
    packagePath: string,
    entries: PackageEntry[]
  ): Promise<PackageDistTags> => {
    const distTagsPath = path.join(packagePath, 'dist-tags.json');
    try {
      const content = await fs.readFile(distTagsPath, 'utf-8');
      const parsed = JSON.parse(content) as PackageDistTags;
      return withComputedLatestDistTag(entries, parsed);
    } catch {
      return withComputedLatestDistTag(entries, {});
    }
  };

  const savePersistableDistTags = async (
    packageName: string,
    entries: PackageEntry[],
    distTags: PackageDistTags
  ): Promise<void> => {
    const packagePath = getPackageRootPath(packageName);
    const distTagsPath = path.join(packagePath, 'dist-tags.json');
    const persistableTags = getPersistableDistTags(entries, distTags);
    if (Object.keys(persistableTags).length === 0) {
      await fs.rm(distTagsPath, { force: true });
      return;
    }

    await fs.mkdir(packagePath, { recursive: true });
    await fs.writeFile(
      distTagsPath,
      JSON.stringify(persistableTags, null, 2),
      'utf-8'
    );
  };

  const loadPackageEntry = async (
    packageName: string,
    version: string,
    versionPath: string
  ): Promise<PackageEntry | undefined> => {
    try {
      const manifestPath = path.join(versionPath, 'package.json');
      const metadataPath = path.join(versionPath, 'metadata.json');
      const manifest = JSON.parse(
        await fs.readFile(manifestPath, 'utf-8')
      ) as NpmPackageManifest;
      const metadataFile = JSON.parse(
        await fs.readFile(metadataPath, 'utf-8')
      ) as {
        readme?: string;
        published?: string;
        shasum: string;
        integrity: string;
        tarballName?: string;
      };

      const tarballName =
        metadataFile.tarballName ??
        createTarballFileName(manifest.name || packageName, version);
      const actualName = manifest.name || packageName;
      const actualVersion = manifest.version || version;

      return {
        metadata: {
          name: actualName,
          version: actualVersion,
          manifest,
          readme: metadataFile.readme,
          published: metadataFile.published ?? new Date().toISOString(),
          shasum: metadataFile.shasum,
          integrity: metadataFile.integrity,
          tarballName,
          tarballUrl: buildTarballUrl(actualName, tarballName),
        },
        storage: {
          packagePathSegments: packageNameToPathSegments(actualName),
          version: actualVersion,
          tarballName,
        },
      };
    } catch (error) {
      logger.warn(
        `Failed to load npm package metadata for ${packageName}@${version}: ${error}`
      );
      return undefined;
    }
  };

  const sortEntries = (entries: PackageEntry[]): PackageEntry[] =>
    entries.sort((a, b) =>
      semver.rcompare(a.metadata.version, b.metadata.version)
    );

  const scanPackageVersions = async (
    packageName: string,
    packagePath: string
  ): Promise<void> => {
    const versionDirs = await fs.readdir(packagePath);
    const entries = (
      await Promise.all(
        versionDirs.map(async (version) => {
          const versionPath = path.join(packagePath, version);
          const stat = await fs.stat(versionPath);
          if (!stat.isDirectory()) {
            return undefined;
          }
          return loadPackageEntry(packageName, version, versionPath);
        })
      )
    ).filter((entry): entry is PackageEntry => entry !== undefined);

    if (entries.length === 0) {
      return;
    }

    const sortedEntries = sortEntries(entries);
    const actualName = sortedEntries[0]!.metadata.name;
    packagesCache.set(normalizeKey(actualName), sortedEntries);
    distTagsCache.set(
      normalizeKey(actualName),
      await loadDistTags(packagePath, sortedEntries)
    );
  };

  const scanPackages = async (): Promise<void> => {
    try {
      const packageDirs = await fs.readdir(packagesRoot);
      await Promise.all(
        packageDirs.map(async (packageDir) => {
          const packagePath = path.join(packagesRoot, packageDir);
          const stat = await fs.stat(packagePath);
          if (!stat.isDirectory()) {
            return;
          }

          if (packageDir.startsWith('@')) {
            const scopedDirs = await fs.readdir(packagePath);
            await Promise.all(
              scopedDirs.map(async (name) => {
                const scopedPackagePath = path.join(packagePath, name);
                const scopedStat = await fs.stat(scopedPackagePath);
                if (scopedStat.isDirectory()) {
                  await scanPackageVersions(
                    `${packageDir}/${name}`,
                    scopedPackagePath
                  );
                }
              })
            );
            return;
          }

          await scanPackageVersions(packageDir, packagePath);
        })
      );
    } catch {
      logger.warn(`Packages directory not found or empty: ${packagesRoot}`);
    }
  };

  const writePackageEntry = async (entry: PackageEntry): Promise<void> => {
    const versionPath = path.join(
      packagesRoot,
      ...entry.storage.packagePathSegments,
      entry.metadata.version
    );
    await fs.mkdir(versionPath, { recursive: true });
    await fs.writeFile(
      path.join(versionPath, 'package.json'),
      JSON.stringify(entry.metadata.manifest, null, 2),
      'utf-8'
    );
    await fs.writeFile(
      path.join(versionPath, 'metadata.json'),
      JSON.stringify(
        {
          readme: entry.metadata.readme,
          published: entry.metadata.published,
          shasum: entry.metadata.shasum,
          integrity: entry.metadata.integrity,
          tarballName: entry.metadata.tarballName,
        },
        null,
        2
      ),
      'utf-8'
    );
  };

  return {
    initialize: async (): Promise<void> => {
      const handle = await cacheLock.writeLock();
      try {
        const startTime = Date.now();
        logger.info('Initializing npm metadata cache...');
        packagesCache.clear();
        distTagsCache.clear();
        await scanPackages();
        const versionCount = Array.from(packagesCache.values()).reduce(
          (sum, entries) => sum + entries.length,
          0
        );
        logger.info(
          `npm metadata cache initialized: ${packagesCache.size} packages, ${versionCount} versions (took ${Date.now() - startTime}ms)`
        );
      } finally {
        handle.release();
      }
    },

    getPackageMetadata: (packageName: string): PackageVersionMetadata[] =>
      (packagesCache.get(normalizeKey(packageName)) ?? []).map(
        (entry) => entry.metadata
      ),

    getPackageVersion: (
      packageName: string,
      version: string
    ): PackageVersionMetadata | undefined =>
      (packagesCache.get(normalizeKey(packageName)) ?? []).find(
        (entry) => entry.metadata.version === version
      )?.metadata,

    getPackageEntry: (
      packageName: string,
      version: string
    ): PackageEntry | undefined =>
      (packagesCache.get(normalizeKey(packageName)) ?? []).find(
        (entry) => entry.metadata.version === version
      ),

    getLatestPackageEntry: (packageName: string): PackageEntry | undefined =>
      (packagesCache.get(normalizeKey(packageName)) ?? [])[0],

    getAllPackageIds: (): string[] =>
      Array.from(packagesCache.values())
        .map((entries) => entries[0]!.metadata.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),

    getDistTags: (packageName: string): PackageDistTags => ({
      ...(distTagsCache.get(normalizeKey(packageName)) ?? {}),
    }),

    updateDistTag: async (
      packageName: string,
      tag: string,
      version: string
    ): Promise<void> => {
      const handle = await cacheLock.writeLock();
      try {
        const key = normalizeKey(packageName);
        const entries = packagesCache.get(key) ?? [];
        if (!entries.some((entry) => entry.metadata.version === version)) {
          throw new Error(`Package ${packageName}@${version} was not found`);
        }
        const nextTags = {
          ...(distTagsCache.get(key) ?? {}),
          [tag]: version,
        };
        const computedTags = withComputedLatestDistTag(entries, nextTags);
        distTagsCache.set(key, computedTags);
        await savePersistableDistTags(
          entries[0]!.metadata.name,
          entries,
          computedTags
        );
      } finally {
        handle.release();
      }
    },

    deleteDistTag: async (packageName: string, tag: string): Promise<void> => {
      const handle = await cacheLock.writeLock();
      try {
        const key = normalizeKey(packageName);
        const entries = packagesCache.get(key) ?? [];
        if (entries.length === 0) {
          throw new Error(`Package ${packageName} was not found`);
        }
        const nextTags = { ...(distTagsCache.get(key) ?? {}) };
        delete nextTags[tag];
        const computedTags = withComputedLatestDistTag(entries, nextTags);
        distTagsCache.set(key, computedTags);
        await savePersistableDistTags(
          entries[0]!.metadata.name,
          entries,
          computedTags
        );
      } finally {
        handle.release();
      }
    },

    updateBaseUrl: async (baseUrl: string): Promise<void> => {
      const handle = await cacheLock.writeLock();
      try {
        currentBaseUrl = baseUrl.replace(/\/$/, '');
        for (const entries of packagesCache.values()) {
          for (const entry of entries) {
            entry.metadata.tarballUrl = buildTarballUrl(
              entry.metadata.name,
              entry.metadata.tarballName
            );
          }
        }
      } finally {
        handle.release();
      }
    },

    addPackageEntry: async (
      entry: PackageEntry,
      policy: DuplicatePackagePolicy = 'error',
      distTags: PackageDistTags = { latest: entry.metadata.version }
    ): Promise<{
      action: 'added' | 'overwritten' | 'ignored' | 'error';
      message?: string;
    }> => {
      const handle = await cacheLock.writeLock();
      try {
        const key = normalizeKey(entry.metadata.name);
        const existingEntries = packagesCache.get(key) ?? [];
        const existingVersion = existingEntries.find(
          (existing) => existing.metadata.version === entry.metadata.version
        );

        if (existingVersion) {
          if (policy === 'ignore') {
            return { action: 'ignored' };
          }
          if (policy === 'error') {
            return {
              action: 'error',
              message: `Package ${entry.metadata.name} version ${entry.metadata.version} already exists`,
            };
          }
        }

        const nextEntries =
          existingVersion && policy === 'overwrite'
            ? existingEntries.filter(
                (existing) =>
                  existing.metadata.version !== entry.metadata.version
              )
            : [...existingEntries];

        entry.metadata.tarballUrl = buildTarballUrl(
          entry.metadata.name,
          entry.metadata.tarballName
        );
        nextEntries.push(entry);
        const sortedEntries = sortEntries(nextEntries);
        packagesCache.set(key, sortedEntries);

        const existingTags = distTagsCache.get(key) ?? {};
        const nextTags = withComputedLatestDistTag(sortedEntries, {
          ...existingTags,
          ...distTags,
        });
        distTagsCache.set(key, nextTags);

        await writePackageEntry(entry);
        await savePersistableDistTags(
          entry.metadata.name,
          sortedEntries,
          nextTags
        );

        logger.info(
          `Package ${existingVersion ? 'overwritten' : 'added'}: ${entry.metadata.name}@${entry.metadata.version}`
        );

        return { action: existingVersion ? 'overwritten' : 'added' };
      } finally {
        handle.release();
      }
    },
  };
};
