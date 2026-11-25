// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isValidPackageName, packageNameToPathSegments } from './npmPackage.ts';

/**
 * Opens a regular file beneath an operator-configured directory.
 * @param root - Trusted directory (it may itself be a configured symlink).
 * @param filePath - Relative path within the directory.
 * @returns The open descriptor and its stat. The caller must close the descriptor.
 * @throws ENOENT for paths outside the directory or non-regular files.
 */
export const openStorageFile = async (
  root: string,
  filePath: string
): Promise<{ file: FileHandle; stats: Stats }> => {
  const unavailable = () =>
    Object.assign(new Error('File not found'), { code: 'ENOENT' });
  if (filePath.includes('\0')) throw unavailable();
  const directory = await realpath(root);
  const candidate = resolve(directory, filePath);
  if (
    !candidate.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  )
    throw unavailable();
  if ((await realpath(candidate)) !== candidate) throw unavailable();
  const file = await open(
    candidate,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0)
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw unavailable();
    // Check that the descriptor belongs to the validated directory entry even
    // when another writer replaces a file between path resolution and open.
    const entry = await lstat(candidate);
    if (
      entry.dev !== stats.dev ||
      entry.ino !== stats.ino ||
      (await realpath(candidate)) !== candidate
    )
      throw unavailable();
    return { file, stats };
  } catch (error) {
    await file.close();
    throw error;
  }
};

/**
 * Reads the contents of a regular registry file under its configured root.
 * @param root - Trusted base directory.
 * @param filePath - Relative path to the file.
 * @returns Bytes from the verified descriptor.
 */
export const readStorageFile = async (
  root: string,
  filePath: string
): Promise<Buffer> => {
  const { file } = await openStorageFile(root, filePath);
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
};

/**
 * Prepares a package directory without following links inside the registry.
 * @param root - Trusted storage root, created on first publication or import.
 * @param name - Valid package name, optionally scoped.
 * @returns Canonical directory for staging and committing package files.
 */
export const preparePackageDirectory = async (
  root: string,
  name: string
): Promise<string> => {
  if (!isValidPackageName(name))
    throw new Error('Invalid package directory name');
  await mkdir(root, { recursive: true });
  let directory = await realpath(root);
  for (const segment of packageNameToPathSegments(name)) {
    directory = join(directory, segment);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await lstat(directory)).isDirectory())
      throw new Error(
        'Package storage must be a directory without symbolic links'
      );
  }
  return directory;
};
