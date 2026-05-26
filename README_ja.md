# npmjs-server

Fastify API と React/MUI 管理 UI を備えた、ファイル配置型の npm パッケージレジストリです。

## 主な機能

- npm registry protocol による metadata、tarball download、publish、search、whoami、dist-tags、ping、audit no-op のサポート
- 上位 npm registry への read-only proxy と tarball cache
- データベース不要のファイルベースストレージ
- scoped package と unscoped package のサポート
- パッケージ一覧、`.tgz` アップロード、ユーザー管理、npm token revoke の UI
- open、publish protected、full protected の認証モード

unpublish、deprecate、2FA、provenance、org/team 権限は最初のバージョンの対象外です。

## 起動

```bash
npmjs-server -p 4873 -c ./config.json -d ./packages
```

初期 admin ユーザーを作成する場合:

```bash
npmjs-server -p 4873 -c ./config.json -d ./packages --auth-init
```

## npm クライアント設定

```bash
npm config set registry http://localhost:4873
npm login --registry http://localhost:4873
npm publish --registry http://localhost:4873
npm install your-package --registry http://localhost:4873
```

legacy login もサポートしています。

```bash
npm login --auth-type=legacy --registry http://localhost:4873
```

## 上位 registry proxy

proxy は明示的に有効化した場合だけ動作します。ローカルパッケージが常に優先され、proxy で取得したパッケージは通常の `packageDir` とは別の cache ディレクトリに保存されます。

```json
{
  "proxy": {
    "enabled": true,
    "upstreamRegistry": "https://registry.npmjs.org/",
    "packageDir": "./proxy-packages"
  }
}
```

`proxy.packageDir` を省略した場合は `<configDir>/proxy-packages` が使われます。CLI では `--proxy`, `--proxy-upstream-registry`, `--proxy-package-dir`、環境変数では `NPMJS_SERVER_PROXY_ENABLED`, `NPMJS_SERVER_PROXY_UPSTREAM_REGISTRY`, `NPMJS_SERVER_PROXY_PACKAGE_DIR` を指定できます。

## ストレージ形式

```text
packages/
  package-name/
    1.0.0/
      package.json
      metadata.json
      package-name-1.0.0.tgz
    dist-tags.json  # 任意 tag が設定された場合のみ作成
  @scope/
    package-name/
      1.0.0/
        package.json
        metadata.json
        package-name-1.0.0.tgz
      dist-tags.json  # 任意 tag が設定された場合のみ作成
```

proxy cache も同じ構造ですが、通常の `packages/` とは分離された `proxy.packageDir` 配下に保存されます。

tarball の解析には `tar-vern` を使います。`package/package.json` と README だけを読み、アーカイブ全体の展開は行いません。

## 開発

```bash
npm install
npm test
```

`npm test` はサーバーと UI をビルドし、npm CLI 統合テストを含む Vitest 全体を実行します。
