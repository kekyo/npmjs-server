# npmjs-server

Fastify API と React/MUI 管理 UI を備えた、ファイル配置型の npm パッケージレジストリです。

## 主な機能

- npm registry protocol による metadata、tarball download、publish、search、whoami、dist-tags、ping、audit no-op のサポート
- 上位 npm registry への read-only proxy と tarball cache
- データベース不要のファイルベースストレージ
- scoped package と unscoped package のサポート
- パッケージ一覧、`.tgz` アップロード、ユーザー管理、npm token revoke の UI
- open、publish protected、full protected の認証モード
- ユーザーごとに設定できる二段階認証。認証アプリのQR登録、復旧コード、再登録に対応

unpublish、deprecate、provenance、org/team 権限は最初のバージョンの対象外です。

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

## 二段階認証（TOTP）

`authMode`が`publish`または`full`の場合、各ユーザーが二段階認証を設定できます。初期状態では無効です。

1. ログイン後、右上のユーザーメニューから「二段階認証」を開きます。
2. 現在のパスワードを入力し、「認証アプリを登録」を押します。
3. 認証アプリでQRコードを読み取ります。読み取れない場合は「手入力用の登録キー」を入力してください。
4. アプリに表示された6桁の確認コードを入力すると、二段階認証が有効になります。
5. 表示された10個の復旧コードを、安全な場所に保存します。この画面を閉じると再表示できません。

QRコードはブラウザー内で生成します。[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html)のTOTPに対応した認証アプリを使用してください。設定はSHA-1、6桁、30秒間隔です。

有効化後は、ログイン時にパスワードと確認コードを入力します。一度使った確認コードは再利用できないため、続けて認証するときは次のコードを待ってください。
確認画面の有効期限は5分、入力は5回までです。失敗を繰り返すと、ユーザー単位と接続元IP単位で最大10分間、試行を制限します。
サーバーと認証アプリの時計を合わせ、公開環境ではHTTPSを使用してください。

端末を紛失した場合は、確認画面で「復旧コードを使う」を選びます。各コードは1回だけ使用できます。ログイン後の再登録にも、別の確認コードまたは復旧コードが必要です。

「二段階認証」の設定画面では、認証アプリの再登録、復旧コードの再発行、二段階認証の解除を行えます。いずれも現在のパスワードと、未使用の確認コードまたは復旧コードが必要です。
再登録中は、新しい確認コードを確認するまで現在の認証アプリを使用できます。登録完了や復旧コードの再発行後は、以前の復旧コードを使用できません。
設定を確定すると、操作中のブラウザーを除くセッションは無効になります。管理者によるパスワードのリセットでも、TOTPの設定は維持されます。

### npmクライアントでの認証

二段階認証が有効なユーザーは、`npm login`のWeb画面でも確認コードまたは復旧コードを入力します。
`npm login --auth-type=legacy`では、npmの案内に従って確認コードを入力してください。`--otp`オプションでも指定できます。

発行済みのnpmトークンを使った`npm publish`、`npm install`、CIの処理に確認コードは不要です。TOTPを有効にしても、既存トークンを変更する必要はありません。

### 鍵の保存と復旧

初回登録時に、`config.json`と同じディレクトリへ暗号化鍵`totp.key`を作成します。
保存先は、`config.json`の`totpKeyFile`または環境変数`NPMJS_SERVER_TOTP_KEY_FILE`で指定できます。環境変数の指定が優先されます。
設定ファイル内の相対パスは`config.json`のディレクトリが基準です。環境変数には絶対パスを指定すると、起動ディレクトリに左右されません。保存先のディレクトリは事前に作成してください。

`users.json`のTOTP登録キーは暗号化して保存し、復旧コードはハッシュのみを保存します。`users.json`と`totp.key`の両方をバックアップし、鍵へのアクセスを制限してください。コンテナーでは鍵も永続ボリュームに保存します。
セッション用の`sessionSecret`は、この暗号化鍵の代わりにはなりません。同じユーザーファイルを複数のサーバープロセスから同時に使用する構成には対応していません。

認証アプリも復旧コードも使用できない場合は、サーバーを停止してから、サーバー管理者が対象ユーザーのTOTPをリセットできます。

```bash
npmjs-server --config-file ./config.json --totp-reset alice
```

このコマンドは停止状態を自動判定しません。実行前にサーバーの停止を確認してください。
対象ユーザーのTOTPと復旧コードを削除し、パスワード、npmトークン、他のユーザーは維持します。再起動後にパスワードでログインし、認証アプリを登録し直してください。

TOTPが有効なユーザーがいる状態で暗号化鍵が失われたり変わったりすると、サーバーは起動しません。バックアップから元の鍵を復元してください。
鍵を復元できない場合は、TOTPが有効な各ユーザーを上記のコマンドでリセットします。リセットに暗号化鍵は不要です。破損した鍵ファイルが残っている場合は、全ユーザーのリセット後に取り除いてから再起動してください。

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
