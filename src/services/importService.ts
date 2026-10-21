// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import semver from 'semver';
import type { Logger } from '../types.ts';
import {
  isValidPackageName,
  packageNameToPathSegments,
} from '../utils/npmPackage.ts';
import { writePrivateFile } from '../utils/atomicFile.ts';
import { createMetadataService, type PackageEntry } from './metadataService.ts';
import { createPackageEntryFromTarball } from './npmPublishService.ts';
import {
  createImportHttpClient,
  parseImportUrl,
  type ImportAuthentication,
} from './importHttpClient.ts';

/** Observed result of one offline import, including incomplete work. */
export interface ImportResult {
  /** Validated package inventories, including dry-run results. */
  targets: Array<{
    /** Package name. */ name: string;
    /** All advertised versions. */ versions: string[];
  }>;
  /** Newly stored archives. */
  imported: number;
  /** Identical archives retained, with metadata reconciled. */
  skipped: number;
  /** Conflicting archives or tags retained at the destination. */
  conflicts: number;
  /** Failed enumeration, metadata, version or tag operations. */
  failed: number;
  /** Missing source information that could not be recovered. */
  warnings: string[];
  /** Failure and conflict descriptions without credentials. */
  errors: string[];
}

/** Configuration for an offline import. */
export interface ImportOptions {
  /** Hosted-only npm endpoint. */
  registryUrl: string;
  /** Normal package storage, with the destination server stopped. */
  packagesRoot: string;
  /** Destination tarball base URL; the server also resolves it at request time. */
  baseUrl: string;
  /** Credentials for the source endpoint. */
  auth: ImportAuthentication;
  /** Enumerates all requested names or rejects if enumeration is incomplete. */
  enumerate: () => Promise<string[]>;
  /** Reports the inventory without modifying the destination. */
  dryRun: boolean;
  /** Progress and diagnostic output. */
  logger: Logger;
}

/** Offline import operation. */
export interface ImportService {
  /** Executes enumeration, validation and storage, reporting all failures. */
  readonly run: () => Promise<ImportResult>;
}

const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a metadata object');
  return value as Record<string, any>;
};

/**
 * Parses a UTF-8 list containing one package name per line.
 * @param content - List contents; empty lines are ignored
 * @returns Unique validated names in input order
 */
export const parsePackageNames = (content: string): string[] => {
  const names = [
    ...new Set(
      content
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
  if (names.some((name) => !isValidPackageName(name)))
    throw new Error('Package list contains an invalid name');
  return names;
};

const matchesChecksums = (
  bytes: Buffer,
  dist: Record<string, any>
): boolean => {
  if (
    dist.shasum !== undefined &&
    (typeof dist.shasum !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(dist.shasum) ||
      createHash('sha1').update(bytes).digest('hex') !==
        dist.shasum.toLowerCase())
  )
    return false;
  if (dist.integrity !== undefined) {
    if (typeof dist.integrity !== 'string') return false;
    const candidates = dist.integrity
      .trim()
      .split(/\s+/)
      .map((item: string) =>
        /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(
          item
        )
      );
    const algorithms = ['sha512', 'sha384', 'sha256', 'sha1'];
    const strongest = algorithms.find((algorithm) =>
      candidates.some((candidate) => candidate?.[1] === algorithm)
    );
    if (
      !strongest ||
      !candidates.some(
        (candidate) =>
          candidate?.[1] === strongest &&
          candidate[2] === createHash(strongest).update(bytes).digest('base64')
      )
    )
      return false;
  }
  return true;
};

const metadataContents = (entry: PackageEntry): string =>
  JSON.stringify(
    {
      // One authoritative file allows metadata reconciliation without partially updating a version.
      manifest: entry.metadata.manifest,
      readme: entry.metadata.readme,
      packageReadme: entry.metadata.packageReadme,
      published: entry.metadata.published ?? null,
      shasum: entry.metadata.shasum,
      integrity: entry.metadata.integrity,
      tarballName: entry.metadata.tarballName,
    },
    null,
    2
  );

const saveVersion = async (
  root: string,
  entry: PackageEntry,
  bytes: Buffer,
  exists: boolean
): Promise<void> => {
  const packageRoot = path.join(root, ...entry.storage.packagePathSegments);
  const versionRoot = path.join(packageRoot, entry.metadata.version);
  if (exists) {
    await writePrivateFile(
      path.join(versionRoot, 'metadata.json'),
      metadataContents(entry)
    );
    return;
  }
  const staging = await fs.mkdtemp(path.join(packageRoot, '.import-'));
  try {
    await fs.writeFile(path.join(staging, entry.metadata.tarballName), bytes, {
      flag: 'wx',
    });
    await fs.writeFile(
      path.join(staging, 'package.json'),
      JSON.stringify(entry.metadata.manifest, null, 2)
    );
    await writePrivateFile(
      path.join(staging, 'metadata.json'),
      metadataContents(entry)
    );
    await fs.rename(staging, versionRoot);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
};

/**
 * Creates a hosted-registry importer, independent of the name enumeration mechanism.
 * @param options - Source, destination and execution settings
 * @returns Runnable offline importer
 * @remarks Run with the destination server stopped. Dependencies are never recursively imported.
 */
export const createImportService = (options: ImportOptions): ImportService => {
  const registry = parseImportUrl(options.registryUrl);
  registry.pathname = `${registry.pathname.replace(/\/+$/, '')}/`;
  if (registry.search) throw new Error('Registry URL must not contain a query');
  const client = createImportHttpClient(options.auth, [registry.href]);
  return {
    run: async () => {
      const result: ImportResult = {
        targets: [],
        imported: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        warnings: [],
        errors: [],
      };
      const fail = (message: string, conflict: boolean) => {
        if (conflict) result.conflicts++;
        else result.failed++;
        result.errors.push(message);
        options.logger.error(message);
      };
      const warn = (message: string) => {
        result.warnings.push(message);
        options.logger.warn(message);
      };
      let names: string[];
      try {
        const input = await options.enumerate();
        if (
          !Array.isArray(input) ||
          input.some(
            (name) => typeof name !== 'string' || !isValidPackageName(name)
          )
        )
          throw new Error('Invalid names');
        names = [...new Set(input)];
      } catch {
        fail('Package enumeration failed; the inventory is incomplete', false);
        return result;
      }
      const metadata = createMetadataService(
        options.packagesRoot,
        options.baseUrl,
        options.logger
      );
      if (!options.dryRun) await metadata.initialize();
      for (const name of names) {
        let packument: Record<string, any>;
        let versions: Record<string, any>;
        let tags: Record<string, string>;
        try {
          packument = object(
            await client.json(new URL(encodeURIComponent(name), registry).href)
          );
          if (packument.name !== name)
            throw new Error('Mismatched package name');
          versions = object(packument.versions);
          if (
            Object.keys(versions).some(
              (version) =>
                !semver.valid(version) ||
                version.includes('/') ||
                version.includes('\\')
            )
          )
            throw new Error('Invalid version');
          tags = object(packument['dist-tags']);
          if (
            Object.values(tags).some((version) => typeof version !== 'string')
          )
            throw new Error('Invalid tags');
        } catch {
          fail(`${name}: metadata request or validation failed`, false);
          continue;
        }
        const versionNames = Object.keys(versions);
        result.targets.push({ name, versions: versionNames });
        options.logger.info(
          `${name}: ${versionNames.join(', ') || '(no versions)'}`
        );
        if (options.dryRun) continue;
        const packageRoot = path.join(
          options.packagesRoot,
          ...packageNameToPathSegments(name)
        );
        const tagsPath = path.join(packageRoot, 'dist-tags.json');
        const existingTags = metadata.getDistTags(name);
        try {
          await fs.mkdir(packageRoot, { recursive: true });
          // Freeze current tags before adding versions so interrupted imports never synthesize latest.
          await writePrivateFile(
            tagsPath,
            JSON.stringify(
              { format: 'npmjs-server/dist-tags-v1', tags: existingTags },
              null,
              2
            )
          );
        } catch {
          fail(`${name}: could not prepare destination tags`, false);
          continue;
        }
        const available = new Set(
          metadata.getPackageMetadata(name).map((entry) => entry.version)
        );
        for (const version of versionNames) {
          const label = `${name}@${version}`;
          try {
            const document = object(versions[version]);
            if (document.name !== name || document.version !== version)
              throw new Error('Version metadata identity mismatch');
            const dist = object(document.dist);
            if (typeof dist.tarball !== 'string')
              throw new Error('Missing tarball URL');
            const tarballUrl = parseImportUrl(
              new URL(dist.tarball, registry).href
            ).href;
            const existing = metadata.getPackageEntry(name, version);
            let bytes: Buffer;
            if (existing) {
              bytes = await fs.readFile(
                path.join(packageRoot, version, existing.metadata.tarballName)
              );
              if (dist.shasum !== undefined || dist.integrity !== undefined) {
                if (!matchesChecksums(bytes, dist)) {
                  fail(
                    `${label}: existing tarball conflicts with source`,
                    true
                  );
                  continue;
                }
              } else if (!bytes.equals(await client.buffer(tarballUrl))) {
                fail(`${label}: existing tarball conflicts with source`, true);
                continue;
              }
            } else {
              bytes = await client.buffer(tarballUrl);
              if (!matchesChecksums(bytes, dist))
                throw new Error('Tarball checksum mismatch');
            }
            const entry = await createPackageEntryFromTarball(
              bytes,
              options.baseUrl
            );
            if (
              entry.metadata.name !== name ||
              entry.metadata.version !== version
            )
              throw new Error('Tarball identity mismatch');
            const readme =
              typeof document.readme === 'string'
                ? document.readme
                : typeof packument.readme === 'string'
                  ? packument.readme
                  : entry.metadata.readme;
            entry.metadata.readme = readme;
            entry.metadata.packageReadme =
              typeof packument.readme === 'string'
                ? packument.readme
                : undefined;
            entry.metadata.manifest = {
              ...entry.metadata.manifest,
              ...document,
              readme,
              dist: {
                ...dist,
                tarball: entry.metadata.tarballUrl,
                shasum: entry.metadata.shasum,
                integrity: entry.metadata.integrity,
              },
            };
            const published = packument.time?.[version];
            entry.metadata.published =
              typeof published === 'string' &&
              !Number.isNaN(Date.parse(published))
                ? published
                : undefined;
            if (!entry.metadata.published)
              warn(`${label}: source publication time unavailable`);
            if (readme === undefined)
              warn(`${label}: source README unavailable`);
            if (dist.shasum === undefined && dist.integrity === undefined)
              warn(
                `${label}: source checksums unavailable; identity was validated`
              );
            await saveVersion(options.packagesRoot, entry, bytes, !!existing);
            available.add(version);
            if (existing) result.skipped++;
            else result.imported++;
            options.logger.info(
              `${label}: ${existing ? 'archive unchanged; metadata reconciled' : 'imported'}`
            );
          } catch {
            fail(
              `${label}: archive validation, download or storage failed`,
              false
            );
          }
        }
        const nextTags = { ...existingTags };
        for (const [tag, version] of Object.entries(tags)) {
          if (!available.has(version)) {
            fail(`${name}: tag ${tag} targets an unavailable version`, false);
            continue;
          }
          if (
            Object.prototype.hasOwnProperty.call(existingTags, tag) &&
            existingTags[tag] !== version
          ) {
            fail(`${name}: tag ${tag} conflicts with destination`, true);
            continue;
          }
          Object.defineProperty(nextTags, tag, {
            value: version,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        try {
          await writePrivateFile(
            tagsPath,
            JSON.stringify(
              { format: 'npmjs-server/dist-tags-v1', tags: nextTags },
              null,
              2
            )
          );
        } catch {
          fail(`${name}: tag storage failed`, false);
        }
      }
      return result;
    },
  };
};
