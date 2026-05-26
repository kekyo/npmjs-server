# npmjs-server

A file-backed npm package registry server with npm CLI protocol support and a React/MUI administration UI.

## Usage

```bash
npmjs-server -p 4873 -c ./config.json -d ./packages
```

Initialize an admin user:

```bash
npmjs-server -p 4873 -c ./config.json -d ./packages --auth-init
```

Configure npm:

```bash
npm config set registry http://localhost:4873
npm login --registry http://localhost:4873
npm publish --registry http://localhost:4873
npm install your-package --registry http://localhost:4873
```

Enable the read-only upstream proxy when you want cache-on-download behavior for packages that are not fully available locally:

```json
{
  "proxy": {
    "enabled": true,
    "upstreamRegistry": "https://registry.npmjs.org/",
    "packageDir": "./proxy-packages"
  }
}
```

## Supported Registry Operations

- `GET /:package`
- `GET /:package/:versionOrTag`
- `GET /:package/-/:tarball`
- `PUT /:package`
- `GET /-/v1/search`
- `GET /-/ping`
- `GET /-/whoami`
- `POST /-/v1/login`
- `PUT /-/user/org.couchdb.user:<username>`
- `GET`, `PUT`, and `DELETE` dist-tag endpoints
- no-op npm audit endpoints

Scoped packages are supported through both `@scope/name` and encoded `@scope%2fname` URLs.

## Storage

The registry stores packages directly on disk:

```text
packages/<packageNamePath>/<version>/package.json
packages/<packageNamePath>/<version>/metadata.json
packages/<packageNamePath>/<version>/<tarball>.tgz
packages/<packageNamePath>/dist-tags.json  # optional, only for non-default dist-tags
```

Tarball metadata is read with `tar-vern`; the server does not shell out to `tar` and does not extract whole package archives.

The proxy cache uses the same storage layout in a separate directory.
