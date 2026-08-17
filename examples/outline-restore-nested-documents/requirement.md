# 要件：ゴミ箱から復元した文書の子文書も一緒に復元する

## 概要

ゴミ箱に入れた文書を復元したとき、その文書の子文書も一緒に復元されるようにします。

> **この要件は、参照アプリケーションの現在の振る舞いを変える showcase 用の要件です。** 参照リビジョンの Outline がこの仕様を持っていると主張するものではありません。現在の振る舞い（Current Behavior）は固定リビジョンのソースから確認した根拠です。目標の振る舞い（Target Requirement）と、[implementation_package.json](implementation_package.json) に記録した人の判断は、公開 Demo のために置いた showcase 上の入力です。両者を混同しないでください。

## 参照情報

- 参照アプリケーション：[Outline](https://github.com/outline/outline)。ここでは、再現可能な公開例としてのみ使用し、この要件の対象製品としては扱いません。コミット [`fb4ad4d`](https://github.com/outline/outline/tree/fb4ad4d0462e89f5764ed36a560adcd10b42e6f5) に固定しています。別途記載がない限り、この例に含まれる Outline 固有の記述（[project_context.json](project_context.json)、[gaps.json](gaps.json)）は、すべてこのリビジョンに照らして確認しています。
- 参照元のソースコードは、この例に複製していません。根拠は、リポジトリ・リビジョン・相対パス・識別子・観測事実で表現しています。
- 技術スタック：TypeScript / Node.js / Koa / Sequelize / PostgreSQL / React / MobX。1 件目・2 件目のリファレンスケース（Spring PetClinic）とは別のプロジェクトです。

## 現在の振る舞い

固定リビジョンで確認できる中心的な事実は、削除と復元の非対称です。

- **削除は子孫へ cascade します。** 文書をゴミ箱へ入れると、`Collection.deleteDocument` が子孫の id を再帰的に取得し、深い側から順に削除して、最後に対象文書を削除します。
- **削除済み文書の復元は、対象文書自身だけを復元します。** `Document.restoreTo` は `deletedAt` の分岐で自身を復元して保存するだけで、子孫を参照しません。
- **archive 側には、子孫をまとめて扱う既存経路があります。** `restoreTo` の `archivedAt` 分岐は `restoreArchivedWithChildren` を呼び、親から子へ再帰的に `archivedAt` を解除します。対になる `archiveWithChildren` も同様です。
- **削除済み子孫は、既定の走査では見えません。** `findAllChildDocumentIds` は既定で `deletedAt` が null の行だけを返し、`paranoid` を無効にした場合だけ削除済みの子孫を返します。

利用者から見た側でも非対称です。削除の確認ダイアログは入れ子の文書が一緒に削除されることを件数付きで示しますが、復元アクションには子孫に関する説明も選択肢もありません。

## 変更内容

- 削除済みの親文書を復元したとき、その子文書（およびさらにその下の子孫）も一緒に復元されるようにします。
- 削除の cascade 自体は変更しません。

## 明示的に未指定の事項

この要件で、実装前に権限を持つ人が決める必要がある事項は次の 2 点です。どちらも、承認される振る舞い（Approved Target）そのものを変える判断です。

1. **どの削除済み子孫まで一緒に復元するか。** 特に、親の cascade 削除で削除された子孫と、それ以前に個別に削除されていた子孫は、固定リビジョンの記録では安全に区別できません。削除の由来を示す列はなく、cascade 削除でも子孫はそれぞれ自分の `deletedAt` を持ちます。
2. **親を復元できる利用者が、子孫の復元権限も持つものとして扱うか。** 権限は文書単位の述語で定義されており、同じ階層でも文書ごとに結果が異なりうることが定義から読み取れます。

これらは意図的に未確定とし、人が判断します。[gaps.json](gaps.json) を参照してください。

## 未確定事項として扱わないもの

以下は、上記 2 点が決まれば決定内容から導かれる実装上の影響であり、独立した人の判断としては扱いません。詳細は [gaps.json](gaps.json) の `derived_implementation_impact` を参照してください。

- 削除済み子孫をどう走査するか（再帰の実装方法、問い合わせの書き方、soft-delete を含める指定）。
- 復元処理の `transaction` 境界と、文書ごとに発行するイベントの粒度。
- 復元した子孫を collection の文書構造へどう再接続するか。
- 復元アクションの画面表現（文言、確認の要否、コンポーネント構成）。
- 既存テストの拡張方法（置き場所、構成、ケースの分割）。

## 検証事項（実装を妨げないもの）

削除済み文書は、各文書の `deletedAt` を個別に見る背景タスクによって 30 日後に恒久削除されます。親子関係は抽出条件に含まれないため、親より前に削除された子孫が既に恒久削除されている場合があります。恒久削除された行はどの復元範囲を選んでも復元できないため、これは承認される振る舞いの選択肢を変えるものではなく、委譲可能な検証事項として扱います。[gaps.json](gaps.json) の `non_blocking_verifications` を参照してください。

## 合意後のパッケージについて

[implementation_package.json](implementation_package.json) の `approved_target` と `human_decisions` は、公開 Demo のために置いた **showcase 上の人の判断**です（`decided_by` は `showcase_human_decision`）。参照リビジョンの Outline が持つ振る舞いでも、Outline の方針でもありません。
