# npmjs-server

A file-backed npm package registry server with a Fastify API and React/MUI administration UI.

## Features

- npm registry protocol support for package metadata, tarball download, publish, search, whoami, dist-tags, ping, and no-op audit endpoints.
- Read-only upstream npm registry proxying with tarball caching.
- File-based package storage. No database is required.
- Scoped and unscoped package support.
- UI for package listing, `.tgz` upload, user management, and npm token revocation.
- Authentication modes for open, publish-protected, and fully protected registries.

Unpublish, deprecate, 2FA, provenance, and org/team permission management are intentionally outside the first version.

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

## Development

```bash
npm install
npm test
```

`npm test` builds the server and UI, then runs the full Vitest suite including npm CLI integration checks.
