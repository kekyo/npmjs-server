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
  try {
    logger.info(
      'Import requires a hosted-only source URL. Stop the destination server before importing.'
    );
    const registryUrl = await promptInput(rl, 'Hosted registry URL');
    parseImportUrl(registryUrl);
    const method = await promptInput(
      rl,
      'Enumeration method (list/nexus)',
      'list'
    );
    let enumerate: (auth: ImportAuthentication) => Promise<string[]>;
    if (method === 'list') {
      const listFile = await promptInput(rl, 'Package name list file');
      if (!listFile) throw new Error('Package name list file is required');
      enumerate = async () =>
        parsePackageNames(await fs.readFile(listFile, 'utf8'));
    } else if (method === 'nexus') {
      const apiUrl = await promptInput(
        rl,
        'Nexus REST API base URL (ending in /service/rest/v1/)'
      );
      parseImportUrl(apiUrl);
      const repository = await promptInput(rl, 'Nexus repository name');
      if (!repository) throw new Error('Nexus repository name is required');
      enumerate = async (auth) =>
        await enumerateNexusPackages(apiUrl, repository, auth);
    } else throw new Error('Unknown enumeration method');
    const authentication = await promptInput(
      rl,
      'Authentication (none/basic/bearer)',
      'none'
    );
    let auth: ImportAuthentication = { type: 'none' };
    if (authentication === 'basic' || authentication === 'bearer') {
      const username =
        authentication === 'basic'
          ? await promptInput(rl, 'Source username')
          : '';
      if (authentication === 'basic' && (!username || username.includes(':')))
        throw new Error('A valid source username is required');
      rl.close();
      const secret = await promptPassword(
        authentication === 'basic' ? 'Source password' : 'Source token'
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
    const packagesRoot = await promptInput(
      rl,
      'Destination package directory',
      config.packageDir || './packages'
    );
    const confirmed = await promptConfirm(
      rl,
      dryRun ? 'Run dry-run?' : 'Start import?',
      false
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
