# Ask Forge — Evaluation

このドキュメントは、公開 Demo の Ask Forge に対して実施した検証内容と、そこで確認できた事実だけをまとめたものです。一般的な Benchmark ではなく、要件を絞った targeted evaluation です。記載する数値は、すべて実際に観測した結果です。A〜F 節は `owner-city-search` を対象とした evaluation、G 節は 2 件目の要件 `same-day-visit` に対する小規模な live qualification、H 節は別プロジェクトを参照する 3 件目の要件 `outline-restore-nested-documents` に対する cross-project qualification です。

## A. 何を評価しているか

Ask Forge の評価対象は「もっともらしい文章を生成できるか」ではなく、「根拠と権限の境界を守れるか」です。少なくとも次の項目を評価しています。

- **Groundedness** — 回答が、取得した Artifact だけに基づいているか。一般的な Spring PetClinic 知識で補っていないか。
- **Routing correctness** — 質問が正しい route と primary source に分類されるか（`current_behavior` / `impact_scope` / `human_decision` / `implementation_handoff` / `forge_design`）。
- **No-silent-inference** — 根拠が途切れたときに、暗黙に埋めず不足として扱えるか。
- **Human authority preservation** — 人間の権限で決めるべき未解決事項を、候補提示にとどめ、Forge 側で決定しないか。
- **Deterministic guardrail effectiveness** — 決定論的な検証・強制が、model 出力の揺らぎを実際に吸収できているか。
- **Retrieval efficiency** — 取得する source 数を必要最小限に抑えられているか。
- **Cache effectiveness** — 同一質問で model 呼び出しを回避できているか。

## B. Grounded synthesis baseline

最初に、Retrieval Routing を入れる前の grounded synthesis 単体を、positive / negative control で確認しました（`scripts/test_grounded_synthesis.py`）。

- **Positive** — 提供した Artifact だけを使い、`gaps.json` に実在する gap ID を参照して回答できること。新しい gap を creative に作らないこと。
- **Negative control（out-of-scope）** — 認証方式のように Artifact に根拠がない質問では、`sufficient` を返さず、不足している根拠を明示すること。存在しない認証関連の gap を捏造しないこと。
- **Insufficient** — 根拠がない場合は推測せず `insufficient` を返すこと。

この baseline により、「Artifact の外に出ない」「根拠がなければ答えない」という基本挙動を先に固定しました。

## C. Retrieval Routing v0.1 の失敗（5/7）

次に、route 分類 + 限定的な追加取得を含む Retrieval Routing を、7 件の targeted case（`scripts/test_retrieval_routing.py` の case A–G）で評価しました。v0.1 の結果は **5/7 PASS** です。

失敗した 2 件は、次の failure mode でした。

1. **`impact_scope` が Artifact に存在しない影響範囲を追加した** — 取得した `project_context.json` の `relevant_implementation_surfaces` に無い DB index などの提案が、影響範囲として出力されることがありました。
2. **out-of-scope で回答と sufficiency が不整合になった** — 認証のような対象外の質問に対し、本文では「根拠がない」と述べながら、`sufficiency` は `sufficient` を返す不整合がありました。

この 2 件が重要なのは、どちらも「Coding Agent に渡した後で気付く」種類の誤りだからです。

- 1 は、根拠のない作業項目を実装範囲に混ぜます。Forge の目的は範囲を根拠付きで絞ることなので、この混入は成果物の信頼性を直接損ないます。
- 2 は、下流が sufficiency を機械的に信頼できなくなることを意味します。文章を読めば不足だと分かる、という状態は自動処理の判断材料になりません。不足は下流が判定できる形で返る必要があります。

つまり、いずれも「文章としては読める」が「Context としては使えない」失敗です。文章品質の指標では捕捉できないため、明示的な検証項目にしています。

## D. Deterministic Guardrails

上記に対し、model の指示文だけに依存せず、決定論的な制御を追加しました（`functions/_lib/retrieval.js`）。

- **Surface allowlist validation** — `impact_scope` の影響範囲は、`project_context.json` に実在する `surface_id` だけを許可し、それ以外は除去します。allowlist を満たす項目が残らない場合は `insufficient` にします。
- **Controller-owned final sufficiency** — 最終的な sufficiency は controller 側が決めます。回答本文が根拠不足を述べている場合、model の申告が何であれ `insufficient` に矯正します。
- **Deterministic evidence_ref following** — gap が既存挙動への `evidence_ref` を明示している場合、その参照先の取得は model の判断ではなく決定論的に行います。
- **最大 2 Sources** — 取得は primary source と、条件を満たす追加 1 件までです。
- **Recursive retrieval なし** — 2 回目の取得後は追加取得を禁止し、探索が広がらないようにしています。
- **Human gap を自動決定しない** — 未解決の gap は候補提示にとどめ、Forge 側で選択しません。

矯正が発生した場合は `validation_warnings` と `guardrails_triggered`（`deterministic_controller`）に記録され、audit trace から確認できます。

## E. Stability Result

Guardrails 追加後の結果です。

- **Qualification: 7/7 PASS**（case A–G）
- **3 回連続の full run** を実施
- **合計 21/21 PASS**
- その 3 run では **validation warning なし**（controller による矯正が発生しなかった）

warning なしで安定した点が重要です。guardrail は「毎回矯正して帳尻を合わせている」のではなく、v0.2 の prompt と組み合わせた状態では、通常時に発火しない安全網として機能しています。

## F. Runtime Behavior（observed example）

公開 Demo の実行時に観測した例です。**production SLA ではなく、観測された一例**です。環境、負荷、model 側の状況で変動します。

| 観測項目 | 観測値 |
| --- | --- |
| authentication negative control（out-of-scope） | model tokens 0 |
| Cache MISS の応答 | 約 8.7 秒 |
| 同一質問の直後の Cache HIT | 約 12〜13 ms |
| Cache HIT の model tokens | 0 |

out-of-scope の判定は決定論的な scope gate で行うため、model を呼ばずに `insufficient` を返します。Cache HIT も model を呼ばず、token budget を消費しません。実際の分布は `scripts/audit_summary.mjs` で `audit_traces` から確認できます（[docs/ask-forge-operations.md](ask-forge-operations.md)）。

## G. Multi-requirement qualification（`same-day-visit`）

2 件目の validated requirement である `same-day-visit` に対して、production の公開 endpoint で小規模な qualification を実施しました（2026-08-17）。目的は benchmark を広げることではなく、同じ Retrieval / Guardrail / Human Authority Architecture が 2 件目の要件でも production model path で成立するかの確認です。1 case あたり原則 1 request で、評価対象は文章の good/bad ではなく architecture contract です。各 case の実測値は [evaluation/same-day-visit-qualification.json](evaluation/same-day-visit-qualification.json) に記録しています。

- **Architecture contract: 6/7 PASS、correctness failure 0 件**（current_behavior / impact_scope / human_decision / focused why / implementation_handoff / negative control / 言い換えによる routing stability）
- **Human Decision は blocking 2 件のみ** — `gap.past_date_policy` と `gap.default_visit_date` です。minVisitDate の実装方法、message key、i18n の反映（derived implementation impact）と timezone 境界（non-blocking verification）は、blocking な Human Decision として提示されませんでした。
- **Cross-requirement contamination なし** — `owner-city-search` の gap も surface も現れませんでした。
- **Unsupported surface なし** — 挙げられた影響範囲・実装範囲はすべて、取得した Artifact に実在する ID でした。
- **Retrieval は最大 2 Sources** — 追加取得が発生したのは focused why の 1 case のみで、gap が明示する `evidence_ref` を決定論的に辿った結果です。
- **Negative control は model 呼び出しなし** — 認証方式の質問は決定論的 scope gate で `insufficient` になり、model tokens 0 を audit で確認しました。
- **Model 呼び出しを伴った成功 4 case の実測値** — total tokens 合計 13,372、latency 5.7〜13.2 秒。cache HIT と scope gate の 2 case は model tokens 0、latency 0 でした。

### Operational failure（correctness failure とは別）

`impact_scope` の 1 case は、production 側の upstream failure により完了しませんでした。**これは evaluation correctness failure ではありません。** route は `impact_scope` / `project_context.json` に正しく分類されたうえで、grounded synthesis 段で upstream error となり、fail-safe が働いて回答を生成せずに終了しています。誤った route も、根拠のない回答も出力していません。

- 1 回だけ再試行し、2 回とも同じ段階で失敗しました（router call のみの 198 tokens を消費、`result_status = upstream_error`、`guardrails_triggered = fail_safe_upstream`）。
- Client 側には Cloudflare edge の非 JSON 502 が返っていました。API 自身の safe JSON error ではないため、画面に表示できる情報は HTTP status だけです。
- **この 2 row 自体の原因は、事後には確定できません。** 実行時の production は `upstream_error_kind` 追加前の code であり、remote audit には `result_status = upstream_error` までしか残っていないためです。この「後から原因を分類できない」状態そのものが、`upstream_error_kind`（migration `0003`）を追加した理由です。

### 追跡調査で判明した failure mechanism

その後、失敗段階（`upstream_failure_stage`）と `finish_reason` を audit に残す diagnostics を追加し（migration `0004`）、同じ requirement・同じ質問を実 model path で 1 回実行したところ、failure を再現したうえで次を観測しました。

| 観測項目 | 観測値 |
| --- | --- |
| `upstream_error_kind` | `malformed_model_json` |
| `upstream_failure_stage` | `content_json` |
| `upstream_finish_reason` | `length` |
| output tokens（router + grounded） | 646 |

grounded synthesis の出力が token 上限（600）に達して打ち切られ、途中で切れた JSON が parse できずに失敗していました。上限を 1,000 に引き上げたところ、同じ質問が `sufficient` で完了し、grounded 出力は 827 tokens でした。**上限 600 では構造的に収まらない出力だった**ことになります。

この mechanism は、上記 2 row と route・primary_source・失敗段階・token 消費パターンが一致します。ただし当該 row 自体には metadata が残っていないため、同一原因であったと断定はしません。

したがってこの qualification が示すのは、`same-day-visit` でも根拠と権限の境界が保たれること、および upstream failure が誤った回答ではなく fail-safe として現れることです。

## H. Cross-project interactive qualification（`outline-restore-nested-documents`）

3 件目の validated requirement は、これまでの 2 件とは**別のプロジェクト**（[Outline](https://github.com/outline/outline)、TypeScript / Koa / Sequelize / React、リビジョン `fb4ad4d`）を参照します。ここで確認したかったのは Project Context の抽出でも schema の一般化でもありません。**すでに用意された、別プロジェクトの Context Artifact を、同じ Ask Forge の interactive consumption path（質問 → routing → 決定論的 source 選択 → grounded synthesis → Evidence / Human Authority controller → 回答）が、プロジェクト固有の retrieval logic を足さずに消費できるか**です。

実行対象は production の公開 endpoint ではなく、**ローカルの request handler と実 model** です（in-memory audit store、response cache 無効、remote D1 は未使用）。各 case の実測値は [evaluation/outline-restore-nested-documents-qualification.json](evaluation/outline-restore-nested-documents-qualification.json) に記録しています。再現コマンドは同ファイルの `note` にあります。

- **Architecture contract: 9/9 PASS、correctness failure 0 件**（current_behavior / impact_scope / human decision 2 種 / 言い換え / why / implementation_handoff / negative control 2 種）。初回 run で 1 件の routing miss がありましたが、project-neutral な修正の後に解消しています（後述）。
- **Outline 固有の retrieval logic は 0 行** — 追加したのは requirement registry の 1 entry と 4 つの Artifact だけです。Outline 専用の route も、`requirementId` による分岐も、`GAP_FOCUS` の追加も、framework 固有の source mapping もありません。
- **Human Decision は blocking 2 件のみ** — `gap.restore_scope`（どの削除済み子孫まで復元するか）と `gap.cascade_restore_authorization`（親の復元権限で子孫まで復元してよいか）です。再帰の実装方法、問い合わせの書き方、transaction とイベントの粒度、画面文言、テスト構成（derived implementation impact）と、恒久削除された子孫（non-blocking verification）は blocking として提示されませんでした。
- **Cross-project contamination なし** — Outline の回答に PetClinic の gap・surface・語彙は現れず、PetClinic の回答に Outline のものも現れませんでした。これは qualification の観察だけでなく、`tests/cross_project.test.js` で machine test しています。
- **現在の振る舞いと showcase target を混同していない** — current_behavior の回答は「復元は対象文書だけで、子孫は削除されたまま」と述べており、Outline が子文書を一緒に復元するとは述べていません。implementation_handoff の回答は、承認済みの target が公開 Demo のための人の判断であることに触れています。
- **Retrieval boundary は不変** — 最大 2 sources、追加取得は focused why の 1 case のみで、`gaps.json` が明示する `evidence_ref` を決定論的に辿った結果です。

### 2 件目のプロジェクトが露出させた routing の意味境界

初回 run では「権限の異なる子文書がある場合はどう扱いますか？」が `human_decision` ではなく `forge_design` に分類されました（再実行しても同じ）。回答自体は `architecture.md` に grounded で Outline の振る舞いを捏造していませんでしたが、対象アプリケーションの未決定事項を尋ねた質問が、Forge 自身の設計に関する質問として扱われていました。同じ論点を要件側の語彙で言い換えた質問は `human_decision` に到達していたため、Artifact の欠落ではなく **router の意味境界の曖昧さ**です。

原因は route の定義そのものにありました。`forge_design` は「Forge principles or architecture」とだけ書かれており、"principles" が対象アプリケーションの方針を尋ねる質問まで引き寄せます。`human_decision` は「未解決の判断」という meta な書き方で、「この場合どう扱うべきか」という形の質問を含むことが示されていませんでした。

修正は **route の意味境界を質問の主題で切り直す**ことだけです。router はまず主題（対象アプリケーションとその要件か、Forge 自身か）を決め、`human_decision` は現在の要件についての未解決の behavior / policy / scope / options / authority を、`forge_design` は Forge 自身を扱うと明示しました。あわせて「対象アプリケーションについての質問は、どう言い換えられていても `forge_design` ではない」ことを明示しています。**プロジェクト固有の分岐、requirement ID の分岐、keyword regex、日本語の定型句照合は一切追加していません**（`tests/routing.test.js` が router contract にこれらの語彙が入らないことを machine test しています）。

修正後、同じ質問は `human_decision` / `gaps.json` に到達し、`gap.cascade_restore_authorization` を含む blocking 2 件を返しました。Forge 自身への質問（「Forge は Human Decision と implementation detail をどう区別しますか？」「Forge の retrieval architecture は？」「Forge の limitation は？」）は引き続き `forge_design` / `architecture.md` です。PetClinic 2 件も再実行し、`GAP_FOCUS` による focus、追加取得、scope gate のいずれも変化していません。この変更で `PROMPT_VERSION` を v0.5 → v0.6 に更新しています。

### 2 件目のプロジェクトが露出させた prompt の曖昧さ

同じ path を別プロジェクトで動かしたことで、プロジェクト固有ではない曖昧さが二つ表面化し、いずれも synthesis prompt の側で解消しました（`PROMPT_VERSION` v0.5。上記の routing 修正とあわせ、最終的に v0.4 → v0.6 になります。cache key の入力なので、既存 cache entry は参照されなくなります）。

| 露出した事象 | 原因 | 対応 |
| --- | --- | --- |
| current_behavior が `contract_validation` で失敗 | model が Artifact 内部に記録された source path（`server/models/Document.ts#...`）を citation として返した | citation は「取得した Artifact 名 + その内部の locator」であり、Artifact 内部の source path は citation ではないことを明示 |
| negative control が `contract_validation` で失敗 | model が `insufficient` を空の answer / 空の evidence で返した。contract は partial 以外で evidence を必須にしている | `insufficient` でも欠けている context を述べ、確認した source を citation することを明示 |

あわせて、prompt に残っていた参照プロジェクト固有の表現（「一般的な Spring PetClinic 知識を使わない」）を、参照プロジェクト・framework・library・domain に関する一般知識全般を使わない、という project-neutral な表現へ変更しました。変更後に PetClinic 2 件の要件を実 model path で再実行し、routing・gap の focus・追加取得・scope gate のいずれも変化がないことを確認しています。

**この節が示す範囲**：Ask Forge の interactive consumption path が、2 プロジェクト / 3 件の validated requirement で成立することを確認した、というところまでです。任意のリポジトリを扱えること、Project Context schema がプロジェクト横断で一般化できること、Outline の製品としての振る舞いを Forge が理解していることは、いずれもこの節の主張ではありません。

## I. Current Limitations

この evaluation の適用範囲は限定的です。

- **要件ごとに検証の深さが異なる** — A〜F 節の evaluation は `owner-city-search` に対するもので、7 case を 3 回連続実行した結果です。`same-day-visit` については G 節の 7 case を 1 回実行した qualification だけ、`outline-restore-nested-documents` については H 節の 9 case を 1 回実行した qualification だけであり、同じ深さでは測定していません。
- **H 節は production endpoint での測定ではない** — ローカルの request handler と実 model による実行です。edge、rate limit、D1、cache の実挙動はこの節に含まれません。
- **開いている Human Decision が複数あるとき、why 質問は個別の理由を返さない** — 質問を 1 件の gap に絞り込む presentation heuristic（`GAP_FOCUS`）は要件ごとの table で、Outline には entry がありません。そのため「なぜ勝手に決めてはいけないのか」に対する回答は、各 gap の `why_not_resolved_automatically` ではなく未解決 2 件の列挙になります。追加取得と source boundary は正しく働いており、根拠のない回答も出していません。要件固有の regex を足せば解消しますが、それは今回検証したい「プロジェクト固有の logic を足さずに扱えるか」に反するため、追加していません。
- **Artifact は curated** — 人手で整理した固定 Artifact を対象としており、自動生成された Context ではありません。
- **Vector DB / Embedding は未使用** — 現在の retrieval は route から primary source への決定論的 mapping です。
- **公開 Demo に general repository ingestion は含まれない** — 任意のリポジトリを調査するパイプラインは対象外です。
- **Evaluation set は小規模かつ targeted** — 7 件の case による対象限定の検証であり、一般 benchmark でも統計的評価でもありません。

したがって本ドキュメントが示すのは、「Ask Forge が一般的に優れている」ことではなく、「限定した対象範囲において、根拠と権限の境界を守る挙動が再現可能である」ことです。
