// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import fs from 'fs/promises';
import path from 'path';
import { packageNameToPathSegments } from '../utils/npmPackage.ts';

/**
 * Service interface for accessing npm package files from disk.
 */
export interface PackageService {
  readonly getTarballFilePath: (
    packageName: string,
    version: string,
    tarballName: string
  ) => Promise<string | undefined>;
  readonly tarballExists: (
    packageName: string,
    version: string,
    tarballName: string
  ) => Promise<boolean>;
}

/**
 * Creates a package file service.
 * @param packagesRoot - Root directory containing package files
 * @returns Configured package service instance
 */
export const createPackageService = (
  packagesRoot: string = './packages'
): PackageService => {
  const getTarballPath = (
    packageName: string,
    version: string,
    tarballName: string
  ): string =>
    path.join(
      packagesRoot,
      ...packageNameToPathSegments(packageName),
      version,
      tarballName
    );

  return {
    getTarballFilePath: async (
      packageName: string,
      version: string,
      tarballName: string
    ): Promise<string | undefined> => {
      const tarballPath = getTarballPath(packageName, version, tarballName);
      try {
        await fs.access(tarballPath);
        return tarballPath;
      } catch {
        return undefined;
      }
    },

    tarballExists: async (
      packageName: string,
      version: string,
      tarballName: string
    ): Promise<boolean> => {
      const tarballPath = getTarballPath(packageName, version, tarballName);
      try {
        await fs.access(tarballPath);
        return true;
      } catch {
        return false;
      }
    },
  };
};
