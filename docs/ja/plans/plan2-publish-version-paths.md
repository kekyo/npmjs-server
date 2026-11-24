# plan2 パッケージ公開時の保存先と上書き制限の問題

`npmjs-server` では、公開者がパッケージに指定したバージョンによって、サーバーがパッケージの保存ルート `packagesRoot` の外に書き込み得る。上書きを禁止する設定でも、公開済みバージョンのアーカイブが差し替わる場合がある。

リリースタグ `0.1.0`、`0.2.0`、`0.3.0` の公開処理を調べ、いずれにも同じ問題を確認した。以下の参照先は `0.3.0`（`c223a260e73f6d93117246af4b1f6d7450e67717`）のソースである。調査範囲はコードの静的確認までで、実行時の再現と運用環境での被害の有無は未確認である。

## 公開 API と認証

通常の npm 公開 API（`PUT`）と Web UI の `POST /api/publish` は同じ保存処理を呼ぶ。既定の認証モードは `none` で、この API に接続できる利用者は認証なしでパッケージを公開できる。認証モードが `publish` または `full` の場合も `publish` ロールで公開できる。[npm 公開 API][npm-api]・[Web UI の公開 API][web-api]・[公開権限][auth]・[設定の既定値][defaults]

## 保存先と重複判定

サーバーは受け取ったアーカイブ（`.tgz`）内の `package/package.json` からパッケージ名 `name` とバージョン `version` を読み取る。パッケージ名の形式を検査し、バージョンについては値の有無だけを調べる。[読み込み時の検査][manifest]・[パッケージ名の検査][name]

サーバーは `version` をバージョン別ディレクトリ名と `.tgz` のファイル名の両方に使う。パス区切りや親ディレクトリを表す要素を含むと、保存先はそのパッケージのディレクトリや `packagesRoot` の外にもなり得る。メタデータの登録まで進むと、同じバージョン別ディレクトリに `package.json` と `metadata.json` も書き込む。実際に変更できる場所はサーバープロセスの書き込み権限に依存する。[アーカイブ名の生成][archive-name]・[アーカイブの保存][publish]・[メタデータの保存][metadata-write]

npm 公開 API は重複を `error` として拒否する。Web UI の API は設定に従い、CLI から起動した場合の既定値は `ignore`（既存版を維持）である。どちらも重複判定では `version` の文字列を比較するため、別の表記が既存のアーカイブと同じ保存先を指しても重複と判定できない。アーカイブはメタデータ登録より先に書き込まれ、登録に失敗しても変更が残り得る。既存版のダウンロード URL はその保存先のファイルを読み出すため、差し替え後の内容を配信し得る。[重複の照合][lookup]・[重複判定と書き込みの順序][publish]・[ダウンロード処理][download]

## プロキシを有効にした場合

`0.3.0` のプロキシは設定した上流レジストリから取得したパッケージをキャッシュする機能で、既定では無効である。上流がパスとして解釈されるバージョンを返すと、その値は一時ファイル名とキャッシュの保存先に使われる。失敗時の再帰削除も同じ保存先を対象とする。アーカイブの名前、バージョン、チェックサムを上流の情報と照合しても、保存先がキャッシュ内に収まることは確認できない。[プロキシの設定][proxy-config]・[上流の情報を使う処理][upstream]・[キャッシュの保存と失敗時の削除][proxy]

一括インポートには独自の検査があり、インポートするバージョンの形式とパス区切りの有無を調べている。[一括インポートの検査][import]

## 問題解消の完了条件

- 両方の公開 API で、保存先を変え得る不正なバージョンをファイルへの書き込み前に拒否する。
- `error` または `ignore` の設定では、既存版の保存先と重なる公開要求を受けた後も、既存版のメタデータとダウンロード URL から取得できるアーカイブの内容が要求を受ける前と一致する。
- プロキシが上流から不正なバージョンを受け取っても、一時保存から失敗時の後始末まで、既存キャッシュとキャッシュの保存ルート外を変更しない。

[npm-api]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/routes/npm/index.ts#L1038-L1066
[web-api]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/routes/api/publish/index.ts#L56-L99
[manifest]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/utils/npmPackage.ts#L175-L183
[name]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/services/npmPublishService.ts#L39-L53
[auth]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/routes/npm/index.ts#L419-L432
[defaults]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/cli.ts#L265-L281
[archive-name]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/utils/npmPackage.ts#L118-L126
[publish]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/services/npmPublishService.ts#L113-L156
[metadata-write]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/services/metadataService.ts#L352-L379
[lookup]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/services/metadataService.ts#L417-L423
[download]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/routes/npm/index.ts#L889-L908
[proxy-config]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/README_ja.md#L830
[upstream]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/routes/npm/index.ts#L931-L952
[proxy]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/services/npmProxyService.ts#L445-L514
[import]: https://github.com/kekyo/npmjs-server/blob/c223a260e73f6d93117246af4b1f6d7450e67717/src/services/importService.ts#L249-L260
