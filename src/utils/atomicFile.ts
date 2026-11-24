// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { constants } from 'fs';
import { access, open, rename, rm, stat } from 'fs/promises';
import { randomBytes } from 'crypto';

/**
 * Reads the permissions to preserve when replacing a writable file.
 * @param filePath - Intended destination
 * @returns Its permission bits, or undefined if the file is absent
 * @throws If the existing file cannot be written or inspected
 */
export const getWritableFileMode = async (
  filePath: string
): Promise<number | undefined> => {
  try {
    await access(filePath, constants.W_OK);
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
};

/**
 * Replaces a file only after its new contents have been written and synced.
 * @param filePath - Destination in an existing, writable directory
 * @param content - Complete replacement contents
 * @param mode - Explicit creation mode, subject to the process umask. When omitted,
 * an existing file retains its permissions and a new file uses normal file permissions.
 * @returns Resolves after the replacement has completed
 */
export const writeAtomicFile = async (
  filePath: string,
  content: string,
  mode?: number
): Promise<void> => {
  const existingMode = await getWritableFileMode(filePath);
  const temporaryPath = `${filePath}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', mode ?? existingMode ?? 0o666);
    try {
      if (mode === undefined && existingMode !== undefined)
        await file.chmod(existingMode);
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

/**
 * Replaces a private file only after its new contents have been written and synced.
 * @param filePath Destination in an existing, writable directory.
 * @param content Complete replacement contents.
 * @returns Resolves after the replacement has completed.
 * @remarks Preserves explicit read-only protection of an existing destination.
 */
export const writePrivateFile = async (
  filePath: string,
  content: string
): Promise<void> => await writeAtomicFile(filePath, content, 0o600);
