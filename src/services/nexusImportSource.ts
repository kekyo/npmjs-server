// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { isValidPackageName } from '../utils/npmPackage.ts';
import {
  createImportHttpClient,
  parseImportUrl,
  type ImportAuthentication,
} from './importHttpClient.ts';

const metadataObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Nexus returned invalid component metadata');
  }
  return value as Record<string, unknown>;
};

/**
 * Enumerates all npm package names in a specified Nexus hosted repository.
 * @param apiUrl - Explicit REST API base URL including /service/rest/v1/
 * @param repository - Name of the hosted repository to enumerate
 * @param auth - Credentials scoped to the supplied API URL
 * @returns Unique package names in the order encountered, with npm scopes restored
 * @remarks Rejects incomplete or inconsistent inventories rather than returning partial names.
 * The caller must select a hosted repository; repository types are not discovered here.
 * @see https://help.sonatype.com/en/components-api.html
 */
export const enumerateNexusPackages = async (
  apiUrl: string,
  repository: string,
  auth: ImportAuthentication
): Promise<string[]> => {
  if (!/^[a-zA-Z0-9-][a-zA-Z0-9_.-]*$/.test(repository)) {
    throw new Error('Invalid Nexus repository name');
  }
  const base = parseImportUrl(apiUrl);
  if (base.search) {
    throw new Error('Nexus API URL must not contain a query');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const client = createImportHttpClient(auth, [base.href]);
  const names = new Set<string>();
  const tokens = new Set<string>();
  let continuationToken: string | null = null;

  do {
    const url = new URL('components', base);
    url.searchParams.set('repository', repository);
    if (continuationToken !== null) {
      url.searchParams.set('continuationToken', continuationToken);
    }
    const page = metadataObject(await client.json(url.href));
    if (!Array.isArray(page.items)) {
      throw new Error('Nexus returned an invalid components page');
    }
    for (const value of page.items) {
      const component = metadataObject(value);
      if (component.repository !== repository || component.format !== 'npm') {
        throw new Error(
          'Nexus returned a component outside the requested npm repository'
        );
      }
      const { group, name } = component;
      if (
        typeof name !== 'string' ||
        (group !== undefined && group !== null && typeof group !== 'string')
      ) {
        throw new Error('Nexus returned an invalid npm package identity');
      }
      // Nexus separates @scope/name into group="scope" and name="name".
      const packageName = group ? `@${group}/${name}` : name;
      if (!isValidPackageName(packageName)) {
        throw new Error('Nexus returned an invalid npm package name');
      }
      names.add(packageName);
    }

    const token = page.continuationToken;
    if (token !== null) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Nexus returned an invalid continuation token');
      }
      if (tokens.has(token)) {
        throw new Error('Nexus returned a repeated continuation token');
      }
      tokens.add(token);
    }
    continuationToken = token;
  } while (continuationToken !== null);

  return [...names];
};
