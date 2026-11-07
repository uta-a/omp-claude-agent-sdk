# omp-claude-agent-sdk

Claude Agent SDK 経由で Claude を使う [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) プラグインです。

- `anthropic agent sdk/opus`
- `anthropic agent sdk/sonnet`
- `anthropic agent sdk/haiku`

エイリアスの具体的なモデルは Claude Code とアカウントの利用権限で決まります。テキスト・画像入力、テキスト／thinking のストリーミング、omp のツール呼び出し、キャンセルに対応します。

## 必要なもの

- omp **18.17.0 以降**
- Bun（開発・このリポジトリの依存関係のインストール用）
- Claude Code の認証。通常は `claude auth login` でログインします。

SDK はプラットフォーム用 Claude Code バイナリを同梱します。別のバイナリを使う場合は `OMP_CLAUDE_EXECUTABLE` に実行ファイルの絶対パスを指定してください。認証情報をこのプラグインにコピーする必要はありません。

## インストール

GitHub から直接インストールできます。npm 公開は不要です。

```sh
omp plugin install github:uta-a/omp-claude-agent-sdk
omp --model "anthropic agent sdk/opus"
```

バージョンを固定する場合は `omp plugin install github:uta-a/omp-claude-agent-sdk#v0.2.0` を使います。更新は `omp plugin upgrade omp-claude-agent-sdk` です。

## ローカル開発

このリポジトリを clone して実行します。

```sh
bun install
omp -e ./src/index.ts --model "anthropic agent sdk/opus"
```

継続的に使う場合はローカルプラグインとしてリンクします。これはユーザーの omp プラグイン設定を変更します。

```sh
omp plugin link .
omp --model "anthropic agent sdk/opus"
```

### `/model` から選ぶ

インストール後に omp を起動（既に起動中なら再起動）し、`/model` を開きます。左側のカテゴリ **`anthropic agent sdk`** を選ぶと、`opus`・`sonnet`・`haiku` が並びます。モデルを選んで Enter を押し、画面下のロール（通常の会話用なら `default`）を選んで Enter で適用してください。

CLI のモデル指定には空白が含まれるため、上記のように引用符で囲みます。v0.1.0 の `claude-agent-sdk/…` から変更したため、保存済みのモデル指定も新しい名前へ変更してください。旧カテゴリは登録しません。

解除は `omp plugin uninstall omp-claude-agent-sdk` です。

## 認証と料金

既定では Claude Code のログインを使います。omp の別プロバイダー用 API キーを誤って引き継がないよう、子プロセスから `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_FOUNDRY_API_KEY` と Bedrock／Vertex／Foundry 選択フラグを除きます。明示的な `CLAUDE_CODE_OAUTH_TOKEN` は引き継ぎます。

API キーなどの環境設定を意図的に使う場合のみ、次のように指定します。この場合は API 側の従量課金等が適用される可能性があります。

```sh
OMP_CLAUDE_AUTH=environment ANTHROPIC_API_KEY=... \
  omp -e ./src/index.ts --model "anthropic agent sdk/opus"
```

プランの制限と利用条件は Anthropic 側に従います。omp の `--api-key` や `/login anthropic` はこの SDK プロバイダーの認証には使用しません。

トークン数と合計コストは SDK が報告した値を使います。合計コストは API 換算の推定値であり、サブスクリプションの実請求額ではありません。エイリアスの固定単価は登録していないためモデル一覧上の単価は 0 ですが、「無料」という意味ではありません。単価内訳とプラン残量の表示には対応していません。

## 動作方式と制約

- **ツールの実行・承認は omp が担当します。** SDK 内蔵ツールを無効化し、現在の omp ツールの JSON Schema を非実行 MCP サーバーで公開します。SDK の `PreToolUse` フックが呼び出しを `defer` し、通常の omp ツール呼び出しへ変換します。SDK 側で実行しようとした場合も拒否します。
- **履歴の正本は omp です。** 各リクエストで最新の会話を JSON トランスクリプトとして渡します。SDK のネイティブな複数ロール履歴の再生ではありません。SDK セッションを永続化・再開せず、omp の分岐・履歴編集・圧縮・モデル切替後にも、その時点の履歴を渡します。過去の thinking と署名は再送しません。
- 子プロセスはリクエストごとに起動します。通常の HTTP プロバイダーより起動負荷とトランスクリプト形式の追加トークンが生じます。
- ユーザー／プロジェクト／ローカルの Claude 設定と外部 MCP は読み込みません。管理ポリシーは SDK 側の仕様に従い適用される場合があります。作業ディレクトリとキャンセルシグナルは omp から引き継ぎます。
- 画像は PNG・JPEG・GIF・WebP に対応します。画像は本文内の参照番号と一緒に実際の画像ブロックとして送ります。
- モデルの登録上限は保守的にコンテキスト 200,000・出力 32,000 トークンです。実際のモデルがより大きな上限を持っていても、ここでは広告しません。
- `maxTokens` は SDK 子プロセスの `CLAUDE_CODE_MAX_OUTPUT_TOKENS`、thinking 無効化は SDK の `thinking`、推論強度は `effort` に渡します（`minimal` は `low`）。最終的な対応範囲は利用モデルと SDK に依存します。
- `toolChoice` は `auto` と `none` に対応し、必須・特定ツール強制はエラーにします。temperature・top-p・stop sequences など SDK が公開しない生成パラメーターは転送しません。

## 開発・検証

```sh
bun run check
bun test
```

回帰テストは認証・ネットワークを使いません。ストリームの重複防止、並列ツール呼び出しの変換、異常終了時の実行防止、キャンセル、履歴・画像変換を検証します。

実環境では omp 18.17.0 / Agent SDK 0.3.319 で以下を確認しました。

- Opus の応答
- Haiku と Sonnet の `read` → ツール結果 → 最終回答
- 画像の色認識
- 応答ストリーミング中のキャンセル

## 参照

- [Claude Agent SDK TypeScript リファレンス](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK ストリーミング](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
