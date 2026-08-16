# 要件：飼い主検索に市区町村を追加する

## 概要

既存の飼い主検索では、姓によって飼い主を検索できます。既存の姓条件に加えて、市区町村の検索条件を追加します。

## 参照情報

- 参照アプリケーション：[Spring PetClinic](https://github.com/spring-projects/spring-petclinic)。ここでは、再現可能な公開例としてのみ使用し、この要件の対象製品としては扱いません。コミット [`88e37c1`](https://github.com/spring-projects/spring-petclinic/tree/88e37c15cf6fc8490b01bc3e8e2c800cec1ac272) に固定しています。別途記載がない限り、この例に含まれる PetClinic 固有の記述（[project_context.json](project_context.json)、[gaps.json](gaps.json)、[implementation_package.json](implementation_package.json)）は、すべてこのリビジョンに照らして確認しています。
- 現在の検索フロー：検索フォームは `Owner` ドメインオブジェクトへ直接バインドされ、姓の入力欄だけを表示します。Controller は `OwnerRepository.findByLastNameStartingWith` を使用して検索します。

## 変更内容

- 既存の飼い主検索フォームに、市区町村の入力欄を追加します。`Owner` モデルにすでに存在する `city` フィールドを使用しますが、現在の検索フォームではこの値を読み取っていません。
- 市区町村が入力された場合、その値で検索結果を絞り込めるようにします。

## 明示的に未指定の事項

- 市区町村の照合方法（完全一致、前方一致、部分一致、および大文字と小文字の区別）。
- 市区町村条件と既存の姓条件をどのように組み合わせるか。一方または両方の入力が空の場合の動作も含みます。

これらは意図的に未確定とし、人間が判断します。[gaps.json](gaps.json) を参照してください。
