# npmjs-server

A simple private npm registry running on Node.js.

![npmjs-server](https://raw.githubusercontent.com/kekyo/npmjs-server/develop/images/npmjs-server-120.png)

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Image Version](https://img.shields.io/docker/v/kekyo/npmjs-server.svg?label=docker)](https://hub.docker.com/r/kekyo/npmjs-server)

---

## What is this?

A server for storing and distributing npm packages within an organization or for personal use. Standard npm clients can publish, search for, and install packages.

Packages and user information are stored in files, so no database is required. Both scoped and unscoped packages are supported.

A browser-based administration UI lets you browse packages and versions, read READMEs, download packages, upload multiple `.tgz` files, manage users, revoke npm tokens, and configure two-step authentication.

### Key Features

- npm client support, including `npm publish`, `npm install`, `npm search`, and `npm dist-tag`.
- File-based storage without a database.
- Three authentication modes: no authentication, authentication for publishing, or authentication for both reading and publishing.
- Optional two-step authentication per user, with QR registration, authenticator codes, and recovery codes.
- Read-only upstream npm registry proxying with package caching.
- Reverse proxy support through a fixed public URL or forwarded headers.
- Run with Docker or Podman.

## System Requirements

Node.js 20.19.0 or later is required. The administration UI is available in a browser.

## Installation

```bash
npm install -g npmjs-server
```

## Usage

```bash
# Start on the default port, 4873
npmjs-server

# Use a different port
npmjs-server --port 3000
```

Open `http://localhost:4873/` in a browser to use the administration UI. Authentication is disabled by default, allowing anyone to read and publish packages. See the documentation to enable authentication.

## Documentation

See the [repository documentation](https://github.com/kekyo/npmjs-server#readme) for npm client setup, storage, configuration, authentication and TOTP recovery, upstream proxying, Docker, and CI usage.

[日本語のドキュメントはこちら。](https://github.com/kekyo/npmjs-server/blob/develop/README_ja.md)

## Pull Requests

Pull requests are welcome. Please submit them against the `develop` branch.

## License

[MIT License](https://github.com/kekyo/npmjs-server/blob/develop/LICENSE)
