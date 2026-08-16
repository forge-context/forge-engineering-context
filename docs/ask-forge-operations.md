# Ask Forge Public Demo v0.1 — Operations

Ask Forge は Cloudflare Pages の静的 LP に、同一 Origin の `POST /api/ask` を加えた限定公開 Demo です。対応要件は `owner-city-search` だけです。Browser は `requirement_id` と 500 文字以内の `question` だけを送り、モデル、Prompt、Artifact、Endpoint、Token 上限は Pages Function が管理します。

## ローカル実行

Node.js 20 以降を用意し、`.dev.vars.example` を `.dev.vars` にコピーします。実値が必要なのは次の三つです。

```dotenv
BAILIAN_API_KEY=...
BAILIAN_BASE_URL=...
BAILIAN_MODEL=qwen3.7-plus
```

Base URL には OpenAI-compatible API の `/v1` 相当までを指定し、`/chat/completions` はコードが追加します。Region や URL を推測せず、使用する Model Studio の値を設定してください。

```sh
npm install
npm run build
npm run db:migrate:local
npm test
npm run dev
```

別の Terminal から確認します。

```sh
curl -sS http://localhost:8788/api/ask \
  -H 'Content-Type: application/json' \
  --data '{"requirement_id":"owner-city-search","question":"実装前に人が決める必要があることは何ですか？"}'
```

`npm test` は Bailian を mock するため課金されません。`npm run test:live` は既存の単発 API smoke test で、明示的に実行した場合だけ実 API を呼びます。

## Limits と D1

日次境界は Japan Standard Time です。既定値は global 300 requests/day、300,000 tokens/day、client ごとに 10 requests/hour と 30 requests/day です。すべて環境変数で変更できます。

Global budget は Bailian 呼び出し前に D1 の一つの statement で request と conservative token reservation（既定 8,000）を確保し、終了後に API が返した input/output/total tokens へ置き換えます。同時呼び出しでも上限を越えて新しい呼び出しを開始しにくい、低トラフィック Demo 向けの設計です。Function が強制終了すると予約が当日中残ることがありますが、過剰利用より早めの停止を選ぶ安全側の挙動です。

Client limit も D1 を使用し、`CF-Connecting-IP` は secret salt 付き SHA-256 にしてから count します。Raw IP は保存しません。Cloudflare Rate Limiting binding の期間はこの 1-hour/day policy と一致しないため、v0.1 では追加 binding は不要です。

## Audit trace

`audit_traces` は request ID、時刻、route、primary/additional source、model/final sufficiency、controller warning、token、latency、result status を記録します。質問は SHA-256 と最大 80 文字の control-character 除去済み preview だけを記録します。API key、Authorization header、raw IP、内部 Prompt、Artifact 本文は保存しません。このログは公開 Demo の技術評価用で、利用者向け Analytics ではありません。

## Cloudflare Pages / D1 の手動設定

1. `npx wrangler login` を行い、`npx wrangler d1 create ask-forge-demo` で D1 を作成します。
2. 表示された database ID を `wrangler.jsonc` の `database_id` にある placeholder と置き換えます。
3. `npx wrangler d1 migrations apply ask-forge-demo --remote` で migration を適用します。
4. Cloudflare Dashboard の Pages project で Settings → Bindings を開き、D1 database binding を追加します。Variable name は `DB`、Database は `ask-forge-demo` です。Preview と Production の両環境を確認します。
5. Settings → Variables and Secrets で `BAILIAN_API_KEY` を encrypted Secret として追加します。
6. 同じ画面で `BAILIAN_BASE_URL` と `BAILIAN_MODEL=qwen3.7-plus` を追加します。必要に応じて `GLOBAL_DAILY_REQUEST_LIMIT=300`、`GLOBAL_DAILY_TOKEN_LIMIT=300000`、`GLOBAL_TOKEN_RESERVATION=8000`、`CLIENT_HOURLY_REQUEST_LIMIT=10`、`CLIENT_DAILY_REQUEST_LIMIT=30`、secret 相当の `CLIENT_HASH_SALT` も追加します。
7. Contact を公開する場合は、Deploy 前に `public-config.js` の `contactEmail` を公開可能な address に設定します。
8. Build command は `npm run build`、build output directory は `dist` にします。`functions/api/ask.js` が `/api/ask` を処理し、それ以外は `dist` の static assets のままです。
9. Git integration で通常どおり Deploy するか、明示的に行う場合だけ `npm run build` 後に `npx wrangler pages deploy dist --project-name <your-pages-project>` を実行します。この repository の作業だけでは Deploy しません。
10. Deploy 後、LP の static asset と `POST /api/ask` の両方を確認します。`GET /api/ask` は 405 です。

環境変数または D1 binding を変えた場合、Pages deployment を作り直して反映を確認してください。Free tier の低トラフィック showcase を前提とし、有料 Dependency はありません。
