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

## Runtime response cache v0.1

安定した質問で Bailian を再度呼ばないため、Pages Function から Cloudflare Cache API を使う runtime cache を持ちます。KV や有料 Dependency は追加していません。

Cache key は request origin 上の内部 URL で、SHA-256 の入力は `requirement_id`、正規化した質問（NFKC・control character 除去・空白畳み込み・trim・小文字化）、reference/context revision（`ARTIFACTS_REVISION`、公開 Artifact 全体の hash）、prompt/controller version（`PROMPT_VERSION`）、model 名（`BAILIAN_MODEL`）です。質問以外はすべて server 側で決まるため、Browser が model や prompt version を指定して cache を汚染することはできません。Artifact または Prompt を変更すると key が変わり、古い応答は参照されなくなります。

Cache 参照は client rate limit と入力 validation の後、global budget 予約の前に行います。HIT では Bailian を呼ばず token budget も消費しません。TTL は 24 時間（`max-age=86400`）です。Cache するのは retrieval が正常終了した grounded response だけで、同じ requirement/context revision に紐づく決定論的な insufficient も含みます。Upstream error、malformed response、rate limit と global budget の 429、validation error は cache しません。保存するのは公開応答と route などの trace 断片だけで、request ID、secret、内部 Prompt、Artifact 本文、client 情報は含みません。Cache が利用できない環境では常に MISS として動作します。

Cloudflare の runtime cache は data center ごとで、global に共有されるものでも永続でもありません。TTL 前に evict されることがあり、その場合は通常どおり MISS として Bailian を呼びます。

## Audit trace

`audit_traces` は request ID、時刻、route、primary/additional source、model/final sufficiency、controller warning、token、latency、result status、`cache_status`（hit / miss / bypass）、`model_called` を記録します。HIT でも audit trace は必ず記録します。質問は SHA-256 と最大 80 文字の control-character 除去済み preview だけを記録します。API key、Authorization header、raw IP、内部 Prompt、Artifact 本文は保存しません。このログは公開 Demo の技術評価用で、利用者向け Analytics ではありません。

## Cloudflare Pages / D1 の手動設定

1. `npx wrangler login` を行い、`npx wrangler d1 create ask-forge-demo` で D1 を作成します。
2. 表示された database ID を `wrangler.jsonc` の `database_id` にある placeholder と置き換えます。
3. `npx wrangler d1 migrations apply ask-forge-demo --remote` で migration を適用します。`0002` は `audit_traces` に `cache_status` と `model_called` を追加する additive migration です。既存 code とも互換なので、Deploy より先に適用してください。
4. Cloudflare Dashboard の Pages project で Settings → Bindings を開き、D1 database binding を追加します。Variable name は `DB`、Database は `ask-forge-demo` です。Preview と Production の両環境を確認します。
5. Settings → Variables and Secrets で `BAILIAN_API_KEY` を encrypted Secret として追加します。
6. 同じ画面で `BAILIAN_BASE_URL` と `BAILIAN_MODEL=qwen3.7-plus` を追加します。必要に応じて `GLOBAL_DAILY_REQUEST_LIMIT=300`、`GLOBAL_DAILY_TOKEN_LIMIT=300000`、`GLOBAL_TOKEN_RESERVATION=8000`、`CLIENT_HOURLY_REQUEST_LIMIT=10`、`CLIENT_DAILY_REQUEST_LIMIT=30`、secret 相当の `CLIENT_HASH_SALT` も追加します。
7. Contact を公開する場合は、Deploy 前に `public-config.js` の `contactEmail` を公開可能な address に設定します。
8. Build command は `npm run build`、build output directory は `dist` にします。`functions/api/ask.js` が `/api/ask` を処理し、それ以外は `dist` の static assets のままです。
9. Git integration で通常どおり Deploy するか、明示的に行う場合だけ `npm run build` 後に `npx wrangler pages deploy dist --project-name <your-pages-project>` を実行します。この repository の作業だけでは Deploy しません。
10. Deploy 後、LP の static asset と `POST /api/ask` の両方を確認します。`GET /api/ask` は 405 です。

環境変数または D1 binding を変えた場合、Pages deployment を作り直して反映を確認してください。Free tier の低トラフィック showcase を前提とし、有料 Dependency はありません。
