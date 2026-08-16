# 要件：当日の診療予約を登録できるようにする

## 概要

現在の診療予約フォームは、翌日以降の日付しか受け付けません。当日の日付でも診療予約を登録できるようにします。

## 参照情報

- 参照アプリケーション：[Spring PetClinic](https://github.com/spring-projects/spring-petclinic)。ここでは、再現可能な公開例としてのみ使用し、この要件の対象製品としては扱いません。コミット [`88e37c1`](https://github.com/spring-projects/spring-petclinic/tree/88e37c15cf6fc8490b01bc3e8e2c800cec1ac272) に固定しています。別途記載がない限り、この例に含まれる PetClinic 固有の記述（[project_context.json](project_context.json)、[gaps.json](gaps.json)、[implementation_package.json](implementation_package.json)）は、すべてこのリビジョンに照らして確認しています。
- 現在の予約フロー：`VisitController.processNewVisitForm` が、入力された日付を `LocalDate.now()` と比較し、**当日を含む未来でない日付を拒否**します。この「翌日以降のみ」という規則は、Controller の検証、`Visit` の既定値、フォームの `min` 属性、エラーメッセージの 4 か所に分かれて存在します。

## 変更内容

- 当日の日付による診療予約の登録を許可します。
- 「翌日以降のみ」という現在の制約を、当日を含む形に緩めます。

## 明示的に未指定の事項

この要件で、実装前に権限を持つ人が決める必要がある事項は次の 2 点です。どちらも、承認される振る舞い（Approved Target）そのものを変える判断です。

1. 当日を許可したあとも、**過去日は引き続き禁止するか**。
2. 新規 Visit フォームの**初期日付を、翌日のままにするか、当日に変更するか**。

これらは意図的に未確定とし、人が判断します。[gaps.json](gaps.json) を参照してください。

## 未確定事項として扱わないもの

以下は、上記 2 点が決まれば決定内容から導かれる実装上の影響であり、独立した人の判断としては扱いません。詳細は [gaps.json](gaps.json) の `derived_implementation_impact` と [implementation_package.json](implementation_package.json) を参照してください。

- `minVisitDate` をどう実装するか（値の変更、撤廃、共有フラグメントの扱い）。
- エラーメッセージについて、既存の `typeMismatch.visitDate` キーを再利用するか新設するか。
- 多言語対応をどう反映するか。

## 検証事項（実装を妨げないもの）

`visit_date` は時刻を持たない `DATE` 列で、「当日」の判定はサーバーの `LocalDate.now()`（システム既定タイムゾーン）に依存します。タイムゾーンや営業時間の概念は、固定リビジョンのコードベースには存在しません。これは記録すべき事実ですが、この要件を実装不能にする根拠は確認できていないため、人の判断待ちの未確定事項ではなく、委譲可能な検証事項として扱います。[gaps.json](gaps.json) の `non_blocking_verifications` を参照してください。
