// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import * as readline from 'readline';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
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
import { parseImportNpmrc, type ImportNpmrc } from './utils/importNpmrc.ts';

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
  const confirm = async (prompt: string) =>
    await readImportInput(() => promptConfirm(rl, prompt, false), rl);
  const readAuthentication = async (
    allowBearer: boolean,
    api: boolean
  ): Promise<ImportAuthentication> => {
    const authentication = await input(
      `${api ? 'Nexus API authentication' : 'Authentication'} (${allowBearer ? 'none/basic/bearer' : 'none/basic'})`,
      'none'
    );
    if (!allowBearer && authentication === 'bearer') {
      logger.error('Nexus enumeration requires none or basic authentication.');
      throw new Error('Unsupported Nexus authentication');
    }
    if (authentication === 'none') return { type: 'none' };
    if (authentication !== 'basic' && authentication !== 'bearer') {
      throw new Error('Unknown authentication method');
    }
    const label = api ? 'Nexus API' : 'Source';
    const username =
      authentication === 'basic'
        ? await input(`${label} username`, undefined)
        : '';
    if (authentication === 'basic' && (!username || username.includes(':'))) {
      throw new Error('A valid source username is required');
    }
    rl.close();
    const secret = await readImportInput(
      () =>
        promptPassword(
          `${label} ${authentication === 'basic' ? 'password' : 'token'}`
        ),
      undefined
    );
    if (!secret) throw new Error('Source credentials are required');
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return authentication === 'basic'
      ? { type: 'basic', username, password: secret }
      : { type: 'bearer', token: secret };
  };
  try {
    logger.info(
      'Import requires a hosted-only source URL. Stop the destination server before importing.'
    );
    const method = await input('Enumeration method (list/nexus)', 'list');
    if (method !== 'list' && method !== 'nexus')
      throw new Error('Unknown enumeration method');
    let npmrc: ImportNpmrc | undefined;
    try {
      // A missing file is normal; catching ENOENT also handles removal between
      // detection and reading without a separate, racy existence check.
      const content = await fs.readFile(
        path.join(os.homedir(), '.npmrc'),
        'utf8'
      );
      npmrc = parseImportNpmrc(content, method, process.env);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          'Could not read or parse ~/.npmrc. Enter import settings manually.'
        );
      }
    }
    if (npmrc) {
      for (const warning of npmrc.warnings) logger.warn(warning);
      if (npmrc.registries.length || npmrc.credentials.length) {
        logger.info(
          'Available ~/.npmrc settings (verify that the selected registry is hosted-only):'
        );
        npmrc.registries.forEach((url, index) =>
          logger.info(`  Registry ${index + 1}: ${url}`)
        );
        for (const { scope, type } of npmrc.credentials)
          logger.info(`  Authentication: ${type} for ${scope}`);
        if (!(await confirm('Use settings from ~/.npmrc?'))) npmrc = undefined;
      } else {
        logger.info(
          'No usable import settings in ~/.npmrc. Enter import settings manually.'
        );
        npmrc = undefined;
      }
    }
    let registryUrl: string;
    if (npmrc?.registries.length === 1) {
      registryUrl = npmrc.registries[0]!;
    } else if (npmrc && npmrc.registries.length > 1) {
      const selection = await input('Registry number', undefined);
      const selected = npmrc.registries[Number(selection) - 1];
      if (!/^\d+$/.test(selection) || !selected)
        throw new Error('Invalid registry selection');
      registryUrl = selected;
    } else {
      registryUrl = await input('Hosted registry URL', undefined);
    }
    parseImportUrl(registryUrl);
    let apiUrl: string | undefined;
    let enumerate: (auth: ImportAuthentication) => Promise<string[]>;
    if (method === 'list') {
      const listFile = await input('Package name list file', undefined);
      if (!listFile) throw new Error('Package name list file is required');
      enumerate = async () =>
        parsePackageNames(await fs.readFile(listFile, 'utf8'));
    } else {
      const nexusApiUrl = await input(
        'Nexus REST API base URL (ending in /service/rest/v1/)',
        undefined
      );
      parseImportUrl(nexusApiUrl);
      apiUrl = nexusApiUrl;
      const repository = await input('Nexus repository name', undefined);
      if (!repository) throw new Error('Nexus repository name is required');
      enumerate = async (auth) =>
        await enumerateNexusPackages(nexusApiUrl, repository, auth);
    }
    const configuredAuth = npmrc?.authenticationFor(registryUrl);
    const auth =
      configuredAuth ?? (await readAuthentication(method === 'list', false));
    // Manually supplied credentials retain the existing authorization for both
    // URLs. npmrc credentials may only be used inside their original scope.
    const apiAuth = apiUrl
      ? (npmrc?.authenticationFor(apiUrl) ??
        (configuredAuth ? await readAuthentication(false, true) : auth))
      : auth;
    const packagesRoot = await input(
      'Destination package directory',
      config.packageDir || './packages'
    );
    const confirmed = await confirm(dryRun ? 'Run dry-run?' : 'Start import?');
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
      enumerate: async () => await enumerate(apiAuth),
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
