import { describe, expect, test } from 'vitest';
import { parseImportNpmrc } from '../src/utils/importNpmrc.ts';

describe('npmrc import settings', () => {
  test('reads comments, quoted values, scoped registries and environment references', () => {
    const settings = parseImportNpmrc(
      `
      ; user settings
      registry = "https://registry.example/hosted/"
      @team:registry = \${TEAM_REGISTRY}
      @other:registry = https://registry.example/hosted/
      //registry.example/hosted/:_authToken = \${SOURCE_TOKEN}
      cache = /unused
    `,
      'list',
      {
        TEAM_REGISTRY: 'https://other.example/npm/',
        SOURCE_TOKEN: 'private-token',
      }
    );
    expect(settings.registries).toEqual([
      'https://registry.example/hosted/',
      'https://other.example/npm/',
    ]);
    expect(
      settings.authenticationFor('https://registry.example/hosted/')
    ).toEqual({ type: 'bearer', token: 'private-token' });
    expect(settings.credentials).toEqual([
      { scope: '//registry.example/hosted/', type: 'bearer' },
    ]);
    expect(settings.warnings).toEqual([]);
  });

  test.each([
    '//registry.example/:_auth=dXNlcjpwYXNzOndvcmQ=',
    '//registry.example/:username=user\n//registry.example/:_password=cGFzczp3b3Jk',
  ])('decodes scoped Basic credentials: %s', (content) => {
    const settings = parseImportNpmrc(content, 'nexus', {});
    expect(settings.authenticationFor('https://registry.example/npm/')).toEqual(
      { type: 'basic', username: 'user', password: 'pass:word' }
    );
  });

  test('uses the longest matching path without crossing host, port or path boundaries', () => {
    const settings = parseImportNpmrc(
      `
      //registry.example/:_authToken=host-token
      //registry.example/npm/:_authToken=npm-token
      //registry.example/npm/private/:_authToken=private-token
    `,
      'list',
      {}
    );
    expect(
      settings.authenticationFor('https://registry.example/npm/private/')
    ).toEqual({ type: 'bearer', token: 'private-token' });
    expect(settings.authenticationFor('https://registry.example/npm')).toEqual({
      type: 'bearer',
      token: 'npm-token',
    });
    expect(
      settings.authenticationFor('https://registry.example/npm-other/')
    ).toEqual({ type: 'bearer', token: 'host-token' });
    expect(
      settings.authenticationFor('https://registry.example:8443/npm/')
    ).toBeUndefined();
    expect(
      settings.authenticationFor('https://registry.example.evil/npm/')
    ).toBeUndefined();
  });

  test('does not use repository credentials for the Nexus REST API', () => {
    const settings = parseImportNpmrc(
      '//registry.example/repository/npm/:_auth=dXNlcjpwYXNz',
      'nexus',
      {}
    );
    expect(
      settings.authenticationFor('https://registry.example/repository/npm/')
    ).toEqual({ type: 'basic', username: 'user', password: 'pass' });
    expect(
      settings.authenticationFor('https://registry.example/service/rest/v1/')
    ).toBeUndefined();
  });

  test('keeps a registry URL but excludes Bearer credentials in Nexus mode', () => {
    const settings = parseImportNpmrc(
      'registry=https://registry.example/npm/\n//registry.example/:_authToken=private-token',
      'nexus',
      {}
    );
    expect(settings.registries).toEqual(['https://registry.example/npm/']);
    expect(settings.credentials).toEqual([]);
    expect(
      settings.authenticationFor('https://registry.example/npm/')
    ).toBeUndefined();
    expect(settings.warnings.join(' ')).toMatch(/Bearer.*Nexus/);
    expect(settings.warnings.join(' ')).not.toContain('private-token');
  });

  test('can use Basic credentials alongside an unusable Nexus Bearer token', () => {
    const settings = parseImportNpmrc(
      '//registry.example/:_authToken=token\n//registry.example/:_auth=dXNlcjpwYXNz',
      'nexus',
      {}
    );
    expect(settings.authenticationFor('https://registry.example/npm/')).toEqual(
      { type: 'basic', username: 'user', password: 'pass' }
    );
  });

  test.each([
    '//registry.example/npm/:_authToken=${MISSING}',
    '//registry.example/npm/:_authToken=${MISSING?}',
    '//registry.example/npm/:_authToken[] = token',
    '//registry.example/npm/:username=user',
    '//registry.example/npm/:_password=cGFzcw==',
    '//registry.example/npm/:_auth=not-base64!',
    '//registry.example/npm/:_auth=dXNlcjpwYXNz=',
    '//registry.example/npm/:_auth=bm9jb2xvbg==',
    '//registry.example/npm/:_authToken="token\\nheader"',
  ])(
    'rejects invalid credentials without falling back to a broader scope: %s',
    (content) => {
      const settings = parseImportNpmrc(
        `//registry.example/:_authToken=parent-token\n${content}`,
        'list',
        {}
      );
      expect(
        settings.authenticationFor('https://registry.example/npm/')
      ).toBeUndefined();
      expect(settings.warnings.length).toBeGreaterThan(0);
    }
  );

  test.each([
    'registry=file:///tmp/packages',
    'registry=https://user:secret@registry.example/',
    'registry=https://registry.example/?secret=private',
    'registry=${MISSING}',
    'registry[]=https://registry.example/',
    '_authToken=unscoped-secret',
    '//user:secret@registry.example/:_authToken=token',
    '//registry.example/?private:_authToken=token',
    '//registry.example/\u001b[31m/:_authToken=token',
  ])(
    'ignores unusable settings without exposing their contents: %s',
    (content) => {
      const settings = parseImportNpmrc(content, 'list', {});
      expect(settings.registries).toEqual([]);
      expect(settings.credentials).toEqual([]);
      expect(settings.warnings.length).toBeGreaterThan(0);
      expect(settings.warnings.join(' ')).not.toMatch(/secret|private|token/);
    }
  );

  test('expands environment variables once and preserves comment characters in secrets', () => {
    const settings = parseImportNpmrc(
      '//registry.example/:_authToken="${TOKEN}"',
      'list',
      { TOKEN: 'literal-${VALUE};#' }
    );
    expect(settings.authenticationFor('https://registry.example/')).toEqual({
      type: 'bearer',
      token: 'literal-${VALUE};#',
    });
  });

  test('treats inherited object properties as missing environment variables', () => {
    const settings = parseImportNpmrc(
      '//registry.example/:_authToken=${TOKEN}',
      'list',
      Object.create({ TOKEN: 'inherited-token' })
    );
    expect(
      settings.authenticationFor('https://registry.example/')
    ).toBeUndefined();
    expect(settings.credentials).toEqual([]);
  });

  test('preserves escaped environment references as literal credentials', () => {
    const settings = parseImportNpmrc(
      '//registry.example/:_authToken=\\${TOKEN}',
      'list',
      { TOKEN: 'not-used' }
    );
    expect(settings.authenticationFor('https://registry.example/')).toEqual({
      type: 'bearer',
      token: '${TOKEN}',
    });
  });
});
