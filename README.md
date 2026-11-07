# omp-claude-agent-sdk

Claude Agent SDK 経由で Claude を使う [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) プラグインです。

`/model` の **`anthropic-agent-sdk`** カテゴリに、バージョン番号・日付を含む正確なモデル ID と正式名を表示します。例：

- `claude-fable-5-1` — Claude Fable 5.1
- `claude-fable-5` — Claude Fable 5
- `claude-opus-5-5` — Claude Opus 5.5
- `claude-sonnet-5-5` — Claude Sonnet 5.5
- `claude-haiku-5-5` — Claude Haiku 5.5

最新世代だけでなく、SDK が選択可能として返す旧版・日付付き ID も登録します。モデル一覧は固定の 3 エイリアスではありません。テキスト・画像入力、テキスト／thinking のストリーミング、omp のツール呼び出し、キャンセルに対応します。

## 必要なもの

- omp **18.17.0 以降**
- Bun（開発・このリポジトリの依存関係のインストール用）
- Claude Code の認証。通常は `claude auth login` でログインします。

SDK はプラットフォーム用 Claude Code バイナリを同梱します。別のバイナリを使う場合は `OMP_CLAUDE_EXECUTABLE` に実行ファイルの絶対パスを指定してください。認証情報をこのプラグインにコピーする必要はありません。

## インストール

GitHub から直接インストールできます。npm 公開は不要です。

```sh
omp plugin install github:uta-a/omp-claude-agent-sdk
omp --model anthropic-agent-sdk/claude-opus-5-5
```

バージョンを固定する場合は `omp plugin install github:uta-a/omp-claude-agent-sdk#v0.4.0` を使います。更新は `omp plugin upgrade omp-claude-agent-sdk` です。

## ローカル開発

このリポジトリを clone して実行します。

```sh
bun install
omp -e ./src/index.ts --model anthropic-agent-sdk/claude-opus-5-5
```

継続的に使う場合はローカルプラグインとしてリンクします。これはユーザーの omp プラグイン設定を変更します。

```sh
omp plugin link .
omp --model anthropic-agent-sdk/claude-opus-5-5
```

### `/model` から選ぶ

インストール後に omp を起動（既に起動中なら再起動）し、`/model` を開きます。左側のカテゴリ **`anthropic-agent-sdk`** を選ぶと、`claude-fable-5-1` などの番号付きモデル ID が並び、詳細には `Claude Fable 5.1` のような正式名が表示されます。モデルを選んで Enter を押し、画面下のロール（通常の会話用なら `default`）を選んで Enter で適用してください。

v0.4.0 ではカテゴリ名をハイフン区切りの `anthropic-agent-sdk` に統一しました。以前のカテゴリ名でモデルを保存している場合は、`/model` から選び直してください。`opus`・`sonnet`・`haiku` の可変エイリアスや旧カテゴリは登録しません。

解除は `omp plugin uninstall omp-claude-agent-sdk` です。

## 認証

プラグイン側での認証設定は不要です。Claude Code のログインをそのまま使います（omp の `/login` は使いません）。

```sh
claude auth login    # 初回のみ。ブラウザで Claude アカウントにログイン
claude auth status   # "loggedIn": true なら完了
```

ログイン期限切れで `authentication_failed` が出た場合は、再度 `claude auth login` を実行してください。

## 利用規約について

Anthropic のヘルプ記事 [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) では、Agent SDK および Agent SDK で作られたサードパーティアプリの利用は、Claude プランでログインしている場合サブスクリプションの利用枠から消費されると案内されています。また [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) では、Pro・Max・Ultra の利用枠は Claude Code と Agent SDK の通常の個人利用を前提としています。

このプラグインを使う際は次を守ってください。

- **各利用者が自分の Claude アカウントで、Anthropic 純正の手順（`claude auth login`）でログインすること。** プラグインは認証情報を収集・保存しません。
- **アカウント・利用枠の共有、他人の利用の肩代わり、再販は禁止です。**
- 通常の個人利用を大きく超える大量の自動実行は避けてください。
- Anthropic の [Usage Policy](https://www.anthropic.com/legal/aup) と各プランの規約に従ってください。

Anthropic の方針は変更される場合があります。利用前に最新の公式文書を確認してください。本 README は法的助言ではありません。

## 認証と料金

既定では Claude Code のログインを使います。omp の別プロバイダー用 API キーを誤って引き継がないよう、子プロセスから `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_FOUNDRY_API_KEY` と Bedrock／Vertex／Foundry 選択フラグを除きます。明示的な `CLAUDE_CODE_OAUTH_TOKEN` は引き継ぎます。

API キーなどの環境設定を意図的に使う場合のみ、次のように指定します。この場合は API 側の従量課金等が適用される可能性があります。

```sh
OMP_CLAUDE_AUTH=environment ANTHROPIC_API_KEY=... \
  omp -e ./src/index.ts --model anthropic-agent-sdk/claude-opus-5-5
```

プランの制限と利用条件は Anthropic 側に従います。omp の `--api-key` や `/login anthropic` はこの SDK プロバイダーの認証には使用しません。

トークン数と合計コストは SDK が報告した値を使います。合計コストとモデル一覧の単価は API 換算の推定値・参考単価であり、サブスクリプションの実請求額ではありません。単価・トークン上限は omp の Anthropic カタログを利用し、未知のモデルには保守的な上限を設定します。SDK が既知のモデルとして列挙しても、地域・利用枠・クレジット等により実際の要求が拒否される場合があります。プラン残量の表示には対応していません。

**Fable はプランによって使用クレジット課金になる場合があります。** SDK の非対話実行では、推論時に追加の同意画面を出さずに課金されることがあります。選択・実行前に Anthropic 側のプランと使用クレジット設定を確認してください。

## モデル一覧の取得・更新

SDK の `supportedModels()` を使用します。通常の SDK 一覧は推奨モデル中心のため、omp の Anthropic カタログの全モデル ID を SDK の `modelPicker` 候補にも渡して、旧版・日付付き ID を含めて列挙します。**候補をそのまま登録するのではなく、SDK が返した行だけ**を使います。SDK が返さなかった制限付きモデルは追加せず、組織ポリシーを迂回しません。

`resolvedModel` で `default`・`opus` 等を実際の番号付き ID に解決し、同じ ID の重複をまとめます。新規モデルなどカタログに正式名がまだない場合も、名前や番号を推測せず SDK の正確な ID を表示します。列挙用の子プロセスにはユーザープロンプトを送らず、モデル推論を実行しません。取得は最大 12 秒で終了し、成功・失敗のいずれも子プロセスを閉じます。

omp の標準モデルキャッシュ（24 時間）を利用します。新モデル・権限変更をすぐ反映したい場合は、`/model` の F5、または次を実行してください。

```sh
omp models refresh anthropic-agent-sdk
omp models anthropic-agent-sdk
```

SDK とモデルカタログの更新はプラグイン依存関係に従います。使用する SDK／バイナリが未対応のモデルを、このプラグインだけで有効化することはできません。未取得・未キャッシュで取得に失敗した場合、架空のモデル一覧へ置き換えません。

## 動作方式と制約

- **ツールの実行・承認は omp が担当します。** SDK 内蔵ツールを無効化し、現在の omp ツールの JSON Schema を非実行 MCP サーバーで公開します。SDK の `PreToolUse` フックが呼び出しを `defer` し、通常の omp ツール呼び出しへ変換します。SDK 側で実行しようとした場合も拒否します。
- **履歴の正本は omp です。** 各リクエストで最新の会話を JSON トランスクリプトとして渡します。SDK のネイティブな複数ロール履歴の再生ではありません。SDK セッションを永続化・再開せず、omp の分岐・履歴編集・圧縮・モデル切替後にも、その時点の履歴を渡します。過去の thinking と署名は再送しません。
- 子プロセスはリクエストごとに起動します。通常の HTTP プロバイダーより起動負荷とトランスクリプト形式の追加トークンが生じます。
- ユーザー／プロジェクト／ローカルの Claude 設定と外部 MCP は読み込みません。管理ポリシーは SDK 側の仕様に従い適用される場合があります。作業ディレクトリとキャンセルシグナルは omp から引き継ぎます。
- 画像は PNG・JPEG・GIF・WebP に対応します。画像は本文内の参照番号と一緒に実際の画像ブロックとして送ります。
- 既知モデルのコンテキスト・出力上限はカタログの値を使います。未知のモデルのみ、保守的にコンテキスト 200,000・出力 32,000 トークンを使います。omp の設定により実効上限がさらに制限される場合があります。
- `maxTokens` は SDK 子プロセスの `CLAUDE_CODE_MAX_OUTPUT_TOKENS`、thinking 無効化は SDK の `thinking`、推論強度は `effort` に渡します（`minimal` は `low`）。最終的な対応範囲は利用モデルと SDK に依存します。
- `toolChoice` は `auto` と `none` に対応し、必須・特定ツール強制はエラーにします。temperature・top-p・stop sequences など SDK が公開しない生成パラメーターは転送しません。

## 開発・検証

```sh
bun run check
bun test
```

回帰テストは認証・ネットワークを使いません。ストリームの重複防止、並列ツール呼び出しの変換、異常終了時の実行防止、キャンセル、履歴・画像変換、モデル ID の正規化・制限された一覧の尊重を検証します。

実環境では omp 18.17.0 / Agent SDK 0.3.319 で以下を確認しました。

- Opus の応答
- Haiku と Sonnet の `read` → ツール結果 → 最終回答
- 画像の色認識
- 応答ストリーミング中のキャンセル

v0.3.0 では omp 18.18.0 / Agent SDK 0.3.319 で、Fable 5／5.1 を含む 17 ID の発見と `/model` 表示を確認しました。Opus 5.5 と日付付き Haiku 4.5 は、応答の実際のモデル ID も選択した ID と一致することを確認しました。Fable の推論は実行していません。

## 参照

- [Claude Agent SDK TypeScript リファレンス](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK ストリーミング](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Claude Code のモデル設定・Fable の使用クレジット](https://code.claude.com/docs/en/model-config)
