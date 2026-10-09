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

## Two-step Authentication

With `authMode` set to `publish` or `full`, users can enable TOTP from "Two-step authentication" in the user menu. Register an authenticator with the displayed QR code and save the ten recovery codes.

UI login and `npm login` then require a second factor. Existing npm tokens continue to work for package operations and CI. The settings screen supports authenticator replacement, recovery code regeneration, and disabling TOTP.

Back up both `users.json` and the encryption key, which defaults to `totp.key` alongside `config.json`. Set `totpKeyFile` or `NPMJS_SERVER_TOTP_KEY_FILE` to change its location.
If both authentication methods are lost, stop the server and run `npmjs-server --config-file ./config.json --totp-reset <username>` to reset the affected account.

See the [complete TOTP guide](https://github.com/kekyo/npmjs-server/blob/main/README.md#two-step-authentication-totp) for login, key storage, and recovery instructions.

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
