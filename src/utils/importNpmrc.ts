// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { parse } from 'ini';
import {
  parseImportUrl,
  type ImportAuthentication,
} from '../services/importHttpClient.ts';

/** Package enumeration modes supported by the offline importer. */
export type ImportEnumerationMethod = 'list' | 'nexus';

/** Validated npmrc values that may be offered for an interactive import. */
export interface ImportNpmrc {
  /** Distinct explicit registry URLs, in configuration order. */
  readonly registries: string[];
  /** Safe authentication summaries, without usernames or secrets. */
  readonly credentials: Array<{
    /** npm URI prefix authorized to receive these credentials. */
    scope: string;
    /** Authentication scheme supported by the selected enumeration mode. */
    type: 'basic' | 'bearer';
  }>;
  /** Diagnostics that never contain configuration values. */
  readonly warnings: string[];
  /**
   * Resolves credentials for a source URL using the most specific matching scope.
   * @param url - Validated registry or enumeration API URL
   * @returns Supported credentials, or undefined when manual input is needed
   */
  readonly authenticationFor: (url: string) => ImportAuthentication | undefined;
}

const directoryPath = (url: URL): string =>
  `${url.pathname.replace(/\/+$/, '')}/`;

const expandValue = (
  value: unknown,
  environment: NodeJS.ProcessEnv
): string | undefined => {
  if (typeof value !== 'string') return undefined;
  let missing = false;
  // Expand once, following npm's escaping and optional-variable syntax. Secrets
  // supplied by the environment may themselves contain literal ${...} strings.
  const expanded = value.replace(
    /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g,
    (
      original: string,
      escapes: string,
      name: string,
      optional: string | undefined
    ) => {
      if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
      const replacement = Object.prototype.hasOwnProperty.call(
        environment,
        name
      )
        ? environment[name]
        : undefined;
      if (replacement === undefined && !optional) missing = true;
      return escapes.slice(escapes.length / 2) + (replacement ?? '');
    }
  );
  return missing || !expanded.trim() || /[\x00-\x1f\x7f]/.test(expanded)
    ? undefined
    : expanded;
};

const decodeCredential = (value: string | undefined): string | undefined => {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  const decoded = bytes.toString('utf8');
  // Buffer's Base64 decoder tolerates malformed input; do not silently repair it.
  if (
    bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '') ||
    (value.includes('=') && value !== bytes.toString('base64')) ||
    !Buffer.from(decoded, 'utf8').equals(bytes) ||
    /[\x00-\x1f\x7f]/.test(decoded)
  )
    return undefined;
  return decoded;
};

/**
 * Parses the supported registry and authentication settings in one user npmrc.
 * @param content - UTF-8 npmrc content
 * @param method - Selected package enumeration mode
 * @param environment - Environment used to expand npmrc variable references
 * @returns Candidates, safe diagnostics and a URL-scoped credential resolver
 * @remarks Does not contact servers, merge other npm configuration, or verify permissions.
 * Invalid credentials block fallback to broader scopes. Nexus never selects Bearer.
 * @see https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/
 */
export const parseImportNpmrc = (
  content: string,
  method: ImportEnumerationMethod,
  environment: NodeJS.ProcessEnv
): ImportNpmrc => {
  const values: Record<string, unknown> = parse(content);
  const registries = new Set<string>();
  const warnings = new Set<string>();
  const groups = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(values)) {
    if (key === 'registry' || /^@[^:/\s]+:registry$/.test(key)) {
      try {
        const expanded = expandValue(value, environment);
        if (!expanded) throw new Error();
        const url = parseImportUrl(expanded);
        if (url.search) throw new Error();
        url.pathname = directoryPath(url);
        registries.add(url.href);
      } catch {
        warnings.add('Ignored an invalid npmrc registry URL.');
      }
      continue;
    }
    const match = /^(\/\/.*):(_authToken|_auth|username|_password)$/.exec(key);
    if (!match) {
      if (['_authToken', '_auth', 'username', '_password'].includes(key)) {
        warnings.add('Ignored unscoped npmrc authentication.');
      }
      continue;
    }
    const scope = match[1]!;
    try {
      // Retain explicit ports: npm scopes omit the scheme, so the target's
      // scheme must determine whether a port is the default during matching.
      const url = parseImportUrl(`https:${scope}`);
      if (url.search || /[\s\x00-\x1f\x7f\\]/.test(scope)) throw new Error();
      const group = groups.get(scope) ?? {};
      group[match[2]!] = value;
      groups.set(scope, group);
    } catch {
      warnings.add('Ignored an invalid npmrc authentication scope.');
    }
  }

  const entries = [...groups].map(([scope, group]) => {
    const get = (key: string) => expandValue(group[key], environment);
    let auth: Exclude<ImportAuthentication, { type: 'none' }> | undefined;
    if ('_authToken' in group && method === 'nexus') {
      warnings.add(
        'Bearer authentication from npmrc is unavailable for Nexus; select none or basic manually if no Basic credentials apply.'
      );
    }
    if ('_authToken' in group && method === 'list') {
      const token = get('_authToken');
      if (token && /^[\x21-\x7e]+$/.test(token))
        auth = { type: 'bearer', token };
    } else {
      let username: string | undefined;
      let password: string | undefined;
      if ('username' in group || '_password' in group) {
        username = get('username');
        password = decodeCredential(get('_password'));
      } else {
        const decoded = decodeCredential(get('_auth'));
        const separator = decoded?.indexOf(':') ?? -1;
        if (decoded && separator > 0) {
          username = decoded.slice(0, separator);
          password = decoded.slice(separator + 1);
        }
      }
      if (username && !username.includes(':') && password)
        auth = { type: 'basic', username, password };
    }
    if (
      !auth &&
      !(
        method === 'nexus' &&
        Object.keys(group).length === 1 &&
        '_authToken' in group
      )
    ) {
      warnings.add('Ignored invalid or incomplete npmrc authentication.');
    }
    return { scope, auth };
  });

  return {
    registries: [...registries],
    credentials: entries.flatMap(({ scope, auth }) =>
      auth ? [{ scope, type: auth.type }] : []
    ),
    warnings: [...warnings],
    authenticationFor: (value) => {
      const target = parseImportUrl(value);
      const matching = entries
        .map((entry) => ({
          ...entry,
          url: parseImportUrl(`${target.protocol}${entry.scope}`),
        }))
        .filter(
          ({ url }) =>
            url.host === target.host &&
            directoryPath(target).startsWith(directoryPath(url))
        );
      matching.sort(
        (a, b) => directoryPath(b.url).length - directoryPath(a.url).length
      );
      // Keep unusable entries here: a bad repository credential must not cause
      // an unrelated credential for the parent host to be used silently.
      return matching[0]?.auth;
    },
  };
};
