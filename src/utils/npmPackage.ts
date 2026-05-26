// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { createHash } from 'crypto';
import { Readable } from 'stream';
import { createTarExtractor } from 'tar-vern';

/**
 * Minimal npm package manifest shape used by the registry.
 */
export interface NpmPackageManifest {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  license?: string;
  author?: unknown;
  maintainers?: unknown[];
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  readme?: string;
  dist?: {
    tarball?: string;
    shasum?: string;
    integrity?: string;
  };
  [key: string]: unknown;
}

/**
 * Information extracted from an npm tarball.
 */
export interface ExtractedNpmTarball {
  manifest: NpmPackageManifest;
  readme?: string;
}

/**
 * Decodes a package name from a route parameter.
 * @param rawName - Encoded or plain package name
 * @returns Decoded npm package name
 */
export const decodePackageName = (rawName: string): string => {
  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
};

/**
 * Builds a package name from optional scope and name route parameters.
 * @param scope - Scope parameter without the leading @
 * @param name - Package name or encoded full name
 * @returns Decoded npm package name
 */
export const buildPackageName = (
  scope: string | undefined,
  name: string
): string =>
  scope ? `@${scope}/${decodePackageName(name)}` : decodePackageName(name);

/**
 * Validates the package name subset supported by this registry.
 * @param packageName - Package name
 * @returns True when the name is accepted
 */
export const isValidPackageName = (packageName: string): boolean =>
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName);

/**
 * Converts a package name into path segments under the package root.
 * @param packageName - Package name
 * @returns Filesystem path segments
 */
export const packageNameToPathSegments = (packageName: string): string[] => {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    if (!scope || !name) {
      throw new Error(`Invalid scoped package name: ${packageName}`);
    }
    return [scope, name];
  }

  return [packageName];
};

/**
 * Encodes a package name for URLs while preserving scoped path structure.
 * @param packageName - Package name
 * @returns URL path
 */
export const encodePackageNameForPath = (packageName: string): string =>
  packageName.startsWith('@')
    ? packageName
        .split('/')
        .map((segment, index) =>
          index === 0 ? segment : encodeURIComponent(segment)
        )
        .join('/')
    : encodeURIComponent(packageName);

/**
 * Gets the unscoped package basename.
 * @param packageName - Package name
 * @returns Basename without scope
 */
export const getUnscopedPackageName = (packageName: string): string =>
  packageName.startsWith('@') ? packageName.split('/')[1]! : packageName;

/**
 * Creates the tarball file name used by npm package URLs.
 * @param packageName - Package name
 * @param version - Package version
 * @returns Tarball file name
 */
export const createTarballFileName = (
  packageName: string,
  version: string
): string => `${getUnscopedPackageName(packageName)}-${version}.tgz`;

/**
 * Calculates npm shasum and integrity values for a tarball.
 * @param tarball - Tarball bytes
 * @returns Dist checksum values
 */
export const calculateDist = (
  tarball: Buffer
): { shasum: string; integrity: string } => ({
  shasum: createHash('sha1').update(tarball).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
});

/**
 * Extracts package.json and README content from a gzipped npm tarball.
 * @param tarball - Tarball bytes
 * @param signal - Optional abort signal
 * @returns Extracted package manifest and readme
 */
export const extractNpmTarball = async (
  tarball: Buffer,
  signal?: AbortSignal
): Promise<ExtractedNpmTarball> => {
  let manifest: NpmPackageManifest | undefined = undefined;
  let readme: string | undefined = undefined;
  const readable = Readable.from(tarball);

  for await (const item of createTarExtractor(readable, 'gzip', signal)) {
    if (item.kind !== 'file') {
      continue;
    }

    const normalizedPath = item.path.replace(/\\/g, '/');
    if (normalizedPath === 'package/package.json') {
      const content = await item.getContent('string');
      manifest = JSON.parse(content) as NpmPackageManifest;
    } else if (
      normalizedPath.toLowerCase().startsWith('package/readme') &&
      readme === undefined
    ) {
      readme = await item.getContent('string');
    }

    if (manifest && readme !== undefined) {
      break;
    }
  }

  if (!manifest) {
    throw new Error('Package tarball does not contain package/package.json');
  }

  if (!manifest.name || !manifest.version) {
    throw new Error('package.json must contain name and version');
  }

  return { manifest, readme };
};
