// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import * as readline from 'readline';
import fs from 'fs/promises';
import type { ServerConfig, Logger } from './types.ts';
import { promptInput, promptPassword, promptConfirm } from './utils/prompt.ts';
import {
  createImportService,
  parsePackageNames,
} from './services/importService.ts';
import {
  parseImportUrl,
  type ImportAuthentication,
} from './services/importHttpClient.ts';
import { enumerateNexusPackages } from './services/nexusImportSource.ts';

const readImportInput = async <T>(
  read: () => Promise<T>,
  rl: readline.Interface | undefined
): Promise<T> => {
  const error = new Error('Import input was interrupted before completion');
  if (process.stdin.readableEnded || process.stdin.destroyed) throw error;
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(error);
  });
  // A pending question does not reject on EOF and would otherwise exit successfully.
  // Only observe input while prompting; closing stdin after confirmation is valid.
  process.stdin.once('end', interrupt);
  process.stdin.once('close', interrupt);
  process.stdin.once('error', interrupt);
  rl?.once('close', interrupt);
  rl?.once('error', interrupt);
  rl?.once('SIGINT', interrupt);
  try {
    return await Promise.race([read(), interrupted]);
  } finally {
    process.stdin.removeListener('end', interrupt);
    process.stdin.removeListener('close', interrupt);
    process.stdin.removeListener('error', interrupt);
    rl?.removeListener('close', interrupt);
    rl?.removeListener('error', interrupt);
    rl?.removeListener('SIGINT', interrupt);
  }
};

/**
 * Runs the interactive offline package importer without starting an HTTP server.
 * @param config - Resolved server configuration, including the normal package directory
 * @param logger - Progress output
 * @param dryRun - Enumerate only, without modifying the destination
 * @returns Exit status: zero for completion or cancellation, one for incomplete imports
 */
export const runImportPackages = async (
  config: ServerConfig,
  logger: Logger,
  dryRun: boolean
): Promise<number> => {
  let rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const input = async (prompt: string, defaultValue: string | undefined) =>
    await readImportInput(() => promptInput(rl, prompt, defaultValue), rl);
  try {
    logger.info(
      'Import requires a hosted-only source URL. Stop the destination server before importing.'
    );
    const registryUrl = await input('Hosted registry URL', undefined);
    parseImportUrl(registryUrl);
    const method = await input('Enumeration method (list/nexus)', 'list');
    let enumerate: (auth: ImportAuthentication) => Promise<string[]>;
    if (method === 'list') {
      const listFile = await input('Package name list file', undefined);
      if (!listFile) throw new Error('Package name list file is required');
      enumerate = async () =>
        parsePackageNames(await fs.readFile(listFile, 'utf8'));
    } else if (method === 'nexus') {
      const apiUrl = await input(
        'Nexus REST API base URL (ending in /service/rest/v1/)',
        undefined
      );
      parseImportUrl(apiUrl);
      const repository = await input('Nexus repository name', undefined);
      if (!repository) throw new Error('Nexus repository name is required');
      enumerate = async (auth) =>
        await enumerateNexusPackages(apiUrl, repository, auth);
    } else throw new Error('Unknown enumeration method');
    const authentication = await input(
      method === 'nexus'
        ? 'Authentication (none/basic)'
        : 'Authentication (none/basic/bearer)',
      'none'
    );
    if (method === 'nexus' && authentication === 'bearer') {
      throw new Error(
        'Nexus enumeration requires none or basic authentication'
      );
    }
    let auth: ImportAuthentication = { type: 'none' };
    if (authentication === 'basic' || authentication === 'bearer') {
      const username =
        authentication === 'basic'
          ? await input('Source username', undefined)
          : '';
      if (authentication === 'basic' && (!username || username.includes(':')))
        throw new Error('A valid source username is required');
      rl.close();
      const secret = await readImportInput(
        () =>
          promptPassword(
            authentication === 'basic' ? 'Source password' : 'Source token'
          ),
        undefined
      );
      if (!secret) throw new Error('Source credentials are required');
      auth =
        authentication === 'basic'
          ? { type: 'basic', username, password: secret }
          : { type: 'bearer', token: secret };
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    } else if (authentication !== 'none')
      throw new Error('Unknown authentication method');
    const packagesRoot = await input(
      'Destination package directory',
      config.packageDir || './packages'
    );
    const confirmed = await readImportInput(
      () => promptConfirm(rl, dryRun ? 'Run dry-run?' : 'Start import?', false),
      rl
    );
    rl.close();
    if (!confirmed) {
      logger.info('Import cancelled.');
      return 0;
    }
    const service = createImportService({
      registryUrl,
      packagesRoot,
      baseUrl: config.baseUrl || '',
      auth,
      enumerate: async () => await enumerate(auth),
      dryRun,
      logger,
    });
    const result = await service.run();
    const versions = result.targets.reduce(
      (count, target) => count + target.versions.length,
      0
    );
    logger.info(
      `${dryRun ? 'Dry-run' : 'Import'} result: Packages: ${result.targets.length}; Versions: ${versions}; Imported: ${result.imported}; Skipped: ${result.skipped}; Conflicts: ${result.conflicts}; Failed: ${result.failed}; Warnings: ${result.warnings.length}`
    );
    return result.failed || result.conflicts ? 1 : 0;
  } finally {
    rl.close();
  }
};
