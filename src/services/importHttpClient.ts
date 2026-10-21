// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

/** Credentials used only within explicitly authorized URL prefixes. */
export type ImportAuthentication =
  | { /** Authentication scheme. */ type: 'none' }
  | {
      /** Authentication scheme. */ type: 'basic';
      /** Source user. */ username: string;
      /** Source password. */ password: string;
    }
  | {
      /** Authentication scheme. */ type: 'bearer';
      /** Source token. */ token: string;
    };

/** Read-only HTTP client for an import source. */
export interface ImportHttpClient {
  /** Downloads a complete JSON metadata document. */
  readonly json: (url: string) => Promise<unknown>;
  /** Downloads unmodified archive bytes. */
  readonly buffer: (url: string) => Promise<Buffer>;
}

/**
 * Validates a source URL without permitting credentials in URLs or non-HTTP protocols.
 * @param value - Source URL
 * @returns Parsed URL
 */
export const parseImportUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid source URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      'Source URLs must use HTTP(S), without credentials or fragments'
    );
  }
  return url;
};

/**
 * Creates a source reader that scopes credentials and rechecks every redirect.
 * @param auth - Source credentials
 * @param credentialUrls - Explicit URL prefixes authorized to receive credentials
 * @returns Source HTTP client
 * @remarks Redirects may leave these prefixes, but never carry credentials with them.
 */
export const createImportHttpClient = (
  auth: ImportAuthentication,
  credentialUrls: string[]
): ImportHttpClient => {
  const prefixes = credentialUrls.map((value) => {
    const url = parseImportUrl(value);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url;
  });
  const authorization =
    auth.type === 'basic'
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
      : auth.type === 'bearer'
        ? `Bearer ${auth.token}`
        : undefined;

  const request = async (value: string, json: boolean): Promise<Buffer> => {
    let url = parseImportUrl(value);
    const signal = AbortSignal.timeout(120_000);
    for (let redirects = 0; redirects <= 10; redirects++) {
      const headers: Record<string, string> = {
        Accept: json ? 'application/json' : 'application/octet-stream',
      };
      if (
        authorization &&
        prefixes.some(
          (prefix) =>
            prefix.origin === url.origin &&
            url.pathname.startsWith(prefix.pathname)
        )
      ) {
        headers.Authorization = authorization;
      }
      let response: Response;
      try {
        response = await fetch(url, { headers, signal, redirect: 'manual' });
      } catch {
        throw new Error('Source request failed or timed out');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Source redirect has no location');
        const next = parseImportUrl(new URL(location, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new Error('Source redirect downgrades HTTPS');
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Source returned HTTP ${response.status}`);
      }
      try {
        return Buffer.from(await response.arrayBuffer());
      } catch {
        throw new Error('Source response was interrupted');
      }
    }
    throw new Error('Too many source redirects');
  };
  return {
    json: async (url) => {
      const bytes = await request(url, true);
      try {
        return JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new Error('Source returned invalid JSON');
      }
    },
    buffer: async (url) => await request(url, false),
  };
};
