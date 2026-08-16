# Forge — AIネイティブ開発のためのエンジニアリングコンテキスト

Forge は、Coding Agent がコードの変更を始める前に、実装に必要なコンテキストを整えます。人間の権限で判断すべき実装上の論点を、暗黙の前提として処理せず、明示的に扱えるようにします。

> **状況:** 初期段階の公開コンセプトショーケースです。本リポジトリには、具体的なリファレンスケース、人手で整理したサンプル成果物、および一つの要件だけを扱う Ask Forge 公開 Demo を収録しています。一般のリポジトリを調査する完全な Forge 実装や本番システムではありません。

---

## 1. 解決する課題

現代の Coding Agent は、ソフトウェア開発における機械的な作業をすでに高い精度で行えます。コードベースとタスクが与えられれば、一般的な実装経路をたどれます。

```
UI / HTML → JavaScript → API path → Controller / Handler → Service → Repository → Database
```

そして、もっともらしい変更を作成できます。この能力は急速に向上しており、Forge が対象とする領域ではありません。

より難しいのは、実装経路を「見つける」ことではなく、コードを書く前に、その経路上の情報を次のように区別することです。

- **観測可能** — コードまたはドキュメントから直接確認できる
- **不明** — エージェントが参照できる情報だけでは判断できない
- **矛盾** — 複数の情報源が異なる内容を示している
- **事実ではなく判断事項** — プロジェクト上の権限を持つ人だけが決めるべき内容

コンテキストが不足していると、Coding Agent は不足部分を仮定で補い、判断を行ったことを示さないまま作業を進める場合があります。その変更はコンパイルでき、表面的なレビューを通過しても、誰も意図していない形で誤っている可能性があります。

Forge は Coding Agent を置き換えるものではありません。その前段に位置し、役割を限定しています。エージェントが解くべき問題を小さくし、根拠を明確にしたうえで、エージェント単独で決めるべきでない事項を人間へ戻します。

## 2. Forge の処理フロー

```
要件
  → 対象範囲を限定した調査
  → 関連するプロジェクトコンテキスト
  → 根拠 / 不明点 / 矛盾
  → 人間による合意
  → 実装可能なコンテキスト
  → Coding Agent
```

このフローでは、次の性質を保つことを重視します。

- **要件に限定した疎なコンテキスト。** Forge はコードベース全体を要約しません。特定の要件が実際に触れる範囲だけを調査します。
- **根拠に基づく調査結果。** プロジェクトに関する各記述は、言い換えではなく、ファイル、シンボル、設定項目などの具体的な情報源を示すことを前提とします。
- **暗黙の推論を行わない。** 根拠が途切れた箇所は、暗黙に解決せず、不明点として記録します。
- **人間の権限を人間に残す。** 照合条件、共有フィールドの責任範囲、後方互換性の方針などは、開発上の観測だけでは確定できません。Forge は推測せず、判断事項として提示します。

このプロセスの出力である「実装可能な引き継ぎ情報」を、人間が決定済みの事項とともに Coding Agent へ渡します。

## 3. リファレンスケース

架空の製品を前提にせず具体例を示すため、本リポジトリでは [Spring PetClinic](https://github.com/spring-projects/spring-petclinic) を使用します。これは、小規模で公開され、広く知られている Spring Boot のサンプルアプリケーションです。再現性を確保するため、コミット [`88e37c1`](https://github.com/spring-projects/spring-petclinic/tree/88e37c15cf6fc8490b01bc3e8e2c800cec1ac272) に固定しています。PetClinic 自体が主題ではありません。読者が実物を確認できる、一般的な小規模 Web アプリケーションの代替例として選んでいます。

このリビジョンの PetClinic では、実際の飼い主検索フローは Controller から Repository を直接呼び出し、中間に独立した Service クラスはありません。これは、前述した一般的な `Controller → Service → Repository` という構成より単純です。以下のリファレンスケースは、一般化したモデルではなく、固定したリビジョンの実装を反映しています。

**要件例:** *既存の飼い主検索フローに市区町村の条件を追加する。*

Forge の処理フローに沿って進めると、次のようになります。

- 調査では、検索フォームやクエリの入口、処理を担う Controller メソッドと Repository クエリ、永続化層に到達する箇所など、実装経路上の関連範囲を特定します。各項目には、固定リビジョンの実コードを示す参照を付けます。
- 新しい市区町村条件の照合方法を Forge 単独では決めません。`"Lond"` が `"London"` に一致するのか、大文字と小文字を区別するのか、既存の姓条件と AND または OR のどちらで組み合わせるのかは未確定です。
- これらを一般的な慣習で補わず、人間の判断を要する未解決事項として記録します。
- 人間が回答した後、その判断を Coding Agent に渡す実装可能なパッケージへ組み込みます。

各段階の成果物は [examples/petclinic](examples/petclinic) にあります。[`requirement.md`](examples/petclinic/requirement.md)、[`project_context.json`](examples/petclinic/project_context.json)、[`gaps.json`](examples/petclinic/gaps.json)、[`implementation_package.json`](examples/petclinic/implementation_package.json) を参照してください。データは意図的に簡略化しており、一度に読み通せることを優先しています。アプリケーション全体を表すものではありません。`gaps.json` は合意前のスナップショット、`implementation_package.json` は未解決事項を決定した後の合意後スナップショットです。このリファレンスケースでは不明点が見つかりましたが、根拠間の矛盾はありませんでした。

## 4. アーキテクチャ / 技術方針

Forge は、大きく二種類のコンテキストを分離します。

- 時間が経過しても比較的安定している**プロジェクト**のコンテキスト
- **特定の要件**に関するコンテキスト。対象となる実装範囲、根拠、そのタスクだけに関係する未解決事項

コンセプト設計では、自由生成ではなく、grep に近い構造検索による決定論的・字句的なコード調査を重視します。調査結果から情報源を追跡できる必要があるためです。対象範囲が広がった場合、関連するプロジェクトコンテキストへ到達する方法として、ハイブリッド検索や検索拡張型の手法も将来の候補になります。現在実行できる Ask Forge Demo は、検証済み Artifact に対する決定論的な bounded retrieval に限られ、リポジトリ調査パイプラインは含みません。

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。本番向けの詳細実装と内部評価手法は、この公開ショーケースの対象外です。

### 評価

公開 Demo には、対象を限定した評価と、実行時の監査可能性があります。routing の正しさ、根拠に基づく回答、暗黙の推論を行わないこと、人間の権限を保つことを検証しており、各 request の route、sufficiency、cache 状態、token、latency は `audit_traces` に記録されます。検証内容と既知の制約は [docs/evaluation.md](docs/evaluation.md) を参照してください。一般的な benchmark ではありません。

## 5. 構想

現在のショーケースは、構想する三層のうち第一層に含まれる、限定的なフローを示します。要件に限定したコンテキスト → 不明点 → 人間による合意 → 実装への引き継ぎ、という流れです。

1. **Project Intelligence** *(計画中の Phase 1 対象範囲)* — 単一プロジェクトを理解し、要件の具体化、影響・難易度・リスクの分析、実装への引き継ぎを支援します。現在のショーケースでは、影響、難易度、リスクの分析はまだ扱っていません。
2. **Organizational Intelligence** — 複数のプロジェクトにまたがる再利用可能な標準、スキル、判断、リスクパターンを蓄積します。
3. **Engineering Intelligence** — 蓄積した Engineering Experience を、新しいプロジェクトの理解・PoC・開発判断に再利用します。

現時点で本リポジトリが扱うのは、前述した第一層の限定的なフローだけです。

---

## リポジトリ構成

```
README.md
docs/
  architecture.md          — コンセプトアーキテクチャの詳細
  ask-forge-operations.md  — 公開 Demo のローカル運用と Cloudflare 設定
  evaluation.md            — 対象を限定した評価内容と既知の制約
functions/
  api/ask.js               — Pages Function の POST /api/ask
migrations/                — D1 の利用量・監査テーブル
examples/
  petclinic/
    requirement.md              — 要件例
    project_context.json        — 関連する実装範囲
    gaps.json                   — 合意前の、人間の権限による判断事項
    implementation_package.json — 判断後の引き継ぎ情報
```

## Ask Forge をローカルで動かす

`.dev.vars.example` を `.dev.vars` にコピーし、`BAILIAN_API_KEY`、`BAILIAN_BASE_URL`、`BAILIAN_MODEL` を設定します。秘密を含む `.dev.vars` は Git の対象外です。

```sh
npm install
npm run build
npm run db:migrate:local
npm run dev
```

別のターミナルから `POST http://localhost:8788/api/ask` を呼び出せます。詳しい request 例、予算、D1、Cloudflare Pages の手動設定は [docs/ask-forge-operations.md](docs/ask-forge-operations.md) にあります。実 API を使わないテストは `npm test`、既存の任意 Live smoke test は `npm run test:live` です。
