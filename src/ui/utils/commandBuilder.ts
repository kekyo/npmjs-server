// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

export interface ServerUrlInfo {
  baseUrl?: string;
  port: number;
  isHttps: boolean;
}

export interface CommandOptions {
  serverUrl: ServerUrlInfo;
  scope?: string;
}

export type RepositoryAuthMode = 'none' | 'publish' | 'full';

const getRegistryUrl = (serverUrl: ServerUrlInfo): string =>
  serverUrl.baseUrl
    ? serverUrl.baseUrl
    : `${serverUrl.isHttps ? 'https' : 'http'}://localhost:${serverUrl.port}`;

/**
 * Builds an npm registry configuration command.
 * @param options - Command options
 * @returns npm config command
 */
export const buildAddSourceCommand = (options: CommandOptions): string => {
  const registryUrl = getRegistryUrl(options.serverUrl);
  return options.scope
    ? `npm config set ${options.scope}:registry ${registryUrl}`
    : `npm config set registry ${registryUrl}`;
};

/**
 * Builds an npm publish command.
 * @param options - Command options
 * @returns npm publish command
 */
export const buildPublishCommand = (options: CommandOptions): string => {
  const registryUrl = getRegistryUrl(options.serverUrl);
  return `npm login --registry ${registryUrl}\nnpm publish --registry ${registryUrl}`;
};

/**
 * Whether npm publish command should be shown in repository info section.
 */
export const shouldShowPublishCommandInRepositoryInfo = (
  authMode: RepositoryAuthMode
): boolean => authMode === 'none';

/**
 * Whether npm publish command should be shown in token examples.
 */
export const shouldShowPublishCommandInApiPasswordExamples = (
  authMode: RepositoryAuthMode
): boolean => authMode === 'publish' || authMode === 'full';

/**
 * Whether npm registry command should be shown in token examples.
 */
export const shouldShowAddSourceCommandInApiPasswordExamples = (
  _authMode: RepositoryAuthMode
): boolean => true;
