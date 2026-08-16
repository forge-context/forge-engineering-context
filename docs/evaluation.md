# Ask Forge — Evaluation

このドキュメントは、公開 Demo の Ask Forge に対して実施した検証内容と、そこで確認できた事実だけをまとめたものです。一般的な Benchmark ではなく、`owner-city-search` という単一要件に絞った targeted evaluation です。記載する数値は、すべて実際に観測した結果です。公開 Demo にはその後 `same-day-visit` を追加していますが、本ドキュメントの測定対象には含みません。

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

## G. Current Limitations

この evaluation の適用範囲は限定的です。

- **この evaluation の対象は `owner-city-search` 1 件** — 公開 Demo は `owner-city-search` と `same-day-visit` の 2 件を提供していますが、本ドキュメントに記載した測定結果はすべて `owner-city-search` に対して観測したものです。`same-day-visit` は同じ retrieval 経路と guardrail を通りますが、この evaluation では測定していません。
- **Artifact は curated** — 人手で整理した固定 Artifact を対象としており、自動生成された Context ではありません。
- **Vector DB / Embedding は未使用** — 現在の retrieval は route から primary source への決定論的 mapping です。
- **公開 Demo に general repository ingestion は含まれない** — 任意のリポジトリを調査するパイプラインは対象外です。
- **Evaluation set は小規模かつ targeted** — 7 件の case による対象限定の検証であり、一般 benchmark でも統計的評価でもありません。

したがって本ドキュメントが示すのは、「Ask Forge が一般的に優れている」ことではなく、「限定した対象範囲において、根拠と権限の境界を守る挙動が再現可能である」ことです。
