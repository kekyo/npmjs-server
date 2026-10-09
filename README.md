# npmjs-server

A file-backed npm package registry server with a Fastify API and React/MUI administration UI.

## Features

- npm registry protocol support for package metadata, tarball download, publish, search, whoami, dist-tags, ping, and no-op audit endpoints.
- Read-only upstream npm registry proxying with tarball caching.
- File-based package storage. No database is required.
- Scoped and unscoped package support.
- UI for package listing, `.tgz` upload, user management, and npm token revocation.
- Authentication modes for open, publish-protected, and fully protected registries.
- Optional two-step authentication per user, with QR registration, recovery codes, and authenticator replacement.

Unpublish, deprecate, provenance, and org/team permission management are intentionally outside the first version.

## Install

```bash
npm install -g npmjs-server
```

## Start

```bash
npmjs-server -p 4873 -c ./config.json -d ./packages
```

Create the initial admin user:

```bash
npmjs-server -p 4873 -c ./config.json -d ./packages --auth-init
```

## npm Client Setup

```bash
npm config set registry http://localhost:4873
npm login --registry http://localhost:4873
npm publish --registry http://localhost:4873
npm install your-package --registry http://localhost:4873
```

Legacy npm login is also supported:

```bash
npm login --auth-type=legacy --registry http://localhost:4873
```

## Two-step Authentication (TOTP)

Users can enable two-step authentication when `authMode` is `publish` or `full`. It is disabled by default.

1. Sign in and open "Two-step authentication" from the user menu in the top right.
2. Enter your current password and select "Register authenticator".
3. Scan the QR code with your authenticator app, or enter the "Manual setup key" if scanning is unavailable.
4. Enter the six-digit code from the app to enable two-step authentication.
5. Save the ten recovery codes somewhere safe. They cannot be displayed again after closing this screen.

The QR code is generated in your browser. Use an authenticator app supporting [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html) TOTP with SHA-1, six digits, and a 30-second period.

Once enabled, signing in requires both your password and an authenticator code. Each code can only be used once; wait for the next code before authenticating again.
Verification expires after five minutes and allows five attempts. Repeated failures are limited per user and client IP for up to ten minutes.
Keep the server and authenticator clocks synchronized, and use HTTPS for public deployments.

If you lose your authenticator, select "Use a recovery code" during verification. Each recovery code works once. Replacing the authenticator after signing in requires another unused authenticator or recovery code.

The settings screen lets you replace the authenticator, regenerate recovery codes, or disable two-step authentication. Each action requires your current password and an unused authenticator or recovery code.
The existing authenticator remains active until its replacement is confirmed. Completing registration or regenerating recovery codes invalidates previous recovery codes.
Completing these changes invalidates all sessions except the browser making the change. Resetting a user's password as an administrator preserves their TOTP settings.

### npm Client Authentication

Users with two-step authentication enabled must also enter an authenticator or recovery code on the `npm login` web page.
With `npm login --auth-type=legacy`, enter the authenticator code when npm prompts for it. You can also supply it with `--otp`.

Existing npm tokens continue to work for `npm publish`, `npm install`, and CI without an authenticator code. Enabling TOTP does not require replacing those tokens.

### Key Storage and Recovery

The first registration creates an encryption key named `totp.key` alongside `config.json`.
Set `totpKeyFile` in the configuration file or the `NPMJS_SERVER_TOTP_KEY_FILE` environment variable to choose another location. The environment variable takes precedence.
Relative paths in the configuration file are resolved from its directory. Use an absolute path in the environment variable to avoid depending on the working directory. Create the destination directory beforehand.

TOTP setup keys are encrypted in `users.json`, and only hashes of recovery codes are stored. Back up both `users.json` and `totp.key`, and restrict access to the key. For containers, keep the key on a persistent volume too.
The session's `sessionSecret` cannot replace this encryption key. Multiple server processes sharing one writable user file are not supported.

If both the authenticator and recovery codes are unavailable, the server administrator can stop the server and reset the affected account:

```bash
npmjs-server --config-file ./config.json --totp-reset alice
```

This command does not detect whether the server is running. Verify that it has stopped before proceeding.
It removes the selected user's TOTP and recovery codes while preserving passwords, npm tokens, and other accounts. Restart the server, sign in with the password, and register a new authenticator.

If enrolled users exist and the encryption key is missing or changed, the server refuses to start. Restore the original key from backup.
If restoration is impossible, reset each enrolled account with the command above. The reset does not require the encryption key. Remove any damaged key file after resetting all enrolled users, then restart the server.

## Upstream Registry Proxy

Proxying only runs when explicitly enabled. Local packages always take priority, and proxied packages are cached in a separate directory from the main `packageDir`.

```json
{
  "proxy": {
    "enabled": true,
    "upstreamRegistry": "https://registry.npmjs.org/",
    "packageDir": "./proxy-packages"
  }
}
```

When `proxy.packageDir` is omitted, `<configDir>/proxy-packages` is used. CLI options are `--proxy`, `--proxy-upstream-registry`, and `--proxy-package-dir`. Environment variables are `NPMJS_SERVER_PROXY_ENABLED`, `NPMJS_SERVER_PROXY_UPSTREAM_REGISTRY`, and `NPMJS_SERVER_PROXY_PACKAGE_DIR`.

## Storage Layout

Packages are stored under the configured package directory:

```text
packages/
  package-name/
    1.0.0/
      package.json
      metadata.json
      package-name-1.0.0.tgz
    dist-tags.json  # optional, only when non-default dist-tags are set
  @scope/
    package-name/
      1.0.0/
        package.json
        metadata.json
        package-name-1.0.0.tgz
      dist-tags.json  # optional, only when non-default dist-tags are set
```

The proxy cache uses the same structure under the separate `proxy.packageDir`.

Tarballs are inspected with `tar-vern`. The server reads `package/package.json` and README entries without extracting the full archive.

## Environment Variables

All server environment variables use the `NPMJS_SERVER_` prefix. Common values:

- `NPMJS_SERVER_PORT`
- `NPMJS_SERVER_CONFIG`
- `NPMJS_SERVER_PACKAGES`
- `NPMJS_SERVER_AUTH_MODE`
- `NPMJS_SERVER_SESSION_SECRET`
- `NPMJS_SERVER_TOTP_KEY_FILE`

## Development

```bash
npm install
npm test
```

`npm test` builds the server and UI, then runs the full Vitest suite including npm CLI integration checks.
