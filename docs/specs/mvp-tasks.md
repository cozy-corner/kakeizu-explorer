# MVP タスク: 日本史 家系図エクスプローラー

設計: [2026-06-14-japan-genealogy-explorer-design.md](./2026-06-14-japan-genealogy-explorer-design.md)

MVP のゴール: **ローカルで動かして、「人物から人物へ渡り歩ける」「2人の経路が出る」を確かめる**。
Vercel / AuraDB などの公開・ホスティングは MVP の外（動くものができてから）。

方針: **一番不確実な ETL（データ）を最優先で潰す**。UI/API は既知の手堅い技術なので後回しでよい。
各見出しがおおよそ 1 PR の単位。

## PR1. 基盤 ✅ 完了
- [x] Docker でローカル Neo4j 起動（データを置く器）
- [x] Next.js (TypeScript) スキャフォルド
- [x] `neo4j-driver` のシングルトン接続ユーティリティ（API Routes 内）

## PR2. ETL スパイク（最優先 / 使い捨て前提・不確実性を殺す）✅ 完了 → 判定 YES
きれいに作らない。「データとして成立するか・面白いか」だけを最短で確認する。
実装・計測の詳細は `scripts/etl-spike/`（`fetch.ts` / `load.ts` / `verify.ts` / `NOTES.md`）。
- [x] Wikidata から実データを一度取得（SPARQL 一発で 60 秒制限内。分割不要）
- [x] 親子(P22/P25/P40)・配偶者(P26)・兄弟(P3373)を正規化してローカル Neo4j にロード
- [x] GDS の WCC + `shortestPath` で検証（手 Cypher の代わりにスクリプト化＝再現可能）:
  - [x] **連結性**: 最大連結成分 = 日本人のみ 13.4% → seed-and-traverse + 外国人剪定で **48.7%**（信長の祖先が 2→16 世代に）
  - [x] **経路の質**: `信長↔家康` 3 hops（婚姻経由・歴史的に妥当）など著名ペアで良好
- [x] 判定: **YES**。ETL を属性フィルタから seed-and-traverse へ転換（下記 PR6 / NOTES.md）

## PR3. 貫通の最小（検索）✅ 完了
- [x] `GET /api/search?q=` — 人物名検索（`{ nodes, edges }` 整形 + テスト）
- [x] 検索ボックスだけの UI → 端から端まで通ることを確認

## PR4. エゴグラフ（渡り歩き）✅ 完了
- [x] `GET /api/person/:id/neighbors?hops=2`（+ テスト）
- [x] 左ペイン: Cytoscape.js エゴグラフ、ノードクリックで再中心化
- [x] 右ペイン: Wikipedia 記事を REST API 直 fetch、「記事なし」処理

> PR3 レビューの積み残し（このルートが 3 本目になるタイミングで対応）:
> - 共通化: `getDriver().session()`→`run`→`finally close` と 503 エラー整形が
>   `health`/`search` で重複。`lib` に `runQuery` / `serviceUnavailable` を抽出して 3 本で共用。
> - 検索 UI 作り直し時: 連打/再検索で古いレスポンスが新しい結果を上書きする race を解消
>   （AbortController で前リクエストを中断、または latest-wins ガード）。

## PR5. 経路探索（目玉機能）✅ 完了
- [x] `GET /api/path?from=&to=` — `shortestPath`（+ テスト）
- [x] 経路探索モード: 2人選択 → 経路ハイライト、「経路が見つかりません」処理

## PR6. データ属性の補完（右ペイン／ノードを「正直」にする）
スパイク(PR2)が seed-and-traverse＋外国人剪定でコア（31,492 ノード・連結 48.7%）を既にロード済みで、
「渡り歩ける」「2人の経路が出る」という MVP のゴールはこの実データで検証済み。残る MVP の穴は属性だけ:
スパイクは `qid + label` のみで、右ペインは label を記事タイトルに当てている（`components/ArticlePane.tsx`
の TODO）ため、タイトル不一致は黙って「記事なし」に落ちる。体験を「だいたい動く」→「ちゃんと動く」に
する分だけ補う（きれいに作り直さない。ETL の本番化＝下記「MVP の外」へ）:
- [ ] スパイクの `fetch.ts`/`load.ts` を最小拡張し `birth, death, image, wikipediaTitle` も取得・ロード（現状 qid+label のみ）
- [ ] `wikipediaTitle` を `search`/`neighbors`/`path` のレスポンスに通す
- [ ] 右ペインを label 当てから `wikipediaTitle` ベースへ（`ArticlePane.tsx` の TODO 解消）

> 注: 右ペインの記事被覆率（PR2 実測）— 日本人コア 95.4%、橋渡し親族 54.5%。橋渡しの約半数は「記事なし」表示になる。

## MVP の外（公開を決めてから）

### ETL の本番化（使い捨てスパイク → 保守可能なパイプライン）
ETL 方式は PR2 で確定済み（種＋seed-and-traverse＋外国人剪定。詳細・計測は `scripts/etl-spike/NOTES.md`）。
属性フィルタ（P27=日本で母集団を絞る）は実在の血縁を切るため**不採用**。当面はスパイクのスクリプトを
`NOTES.md` の手順で再実行すれば足りるので、ここは公開を決めてから固める:
- [ ] 種/探索/剪定を使い捨てスパイクから保守可能な実装へ整理:
  - **① 種**: `P27=Q17` または `P27→P17=日本`（江戸幕府・大日本帝国など歴史的国家を含む。Q17 のみだと前近代を取りこぼす）
  - **② 探索**: 種から家族関係(P22/P25/P40/P26/P3373)を**国籍無視で辿り**、無タグの橋渡し親族（「○○の娘」級）を回収。連結の生命線（信長の祖先が 2→16 世代に伸びる）
  - **③ 剪定**: 「国籍を持つが日本（広義）が一つも無い」ノードを除去（レノン等の世界系図への漏れを防ぐ）。出生地(P19→P17)は不安定なので**使わない**
- [ ] 親子方向の正規化（P22/P25/P40 → `PARENT_OF`）＋重複排除を実装に固める
- [ ] 正規化・日本人判定・外国人剪定ロジックのユニットテスト
- [ ] `qid` ユニーク制約・全件ロードの再現可能な手順化
- [ ] WDQS クライアントの本番化: Retry-After 尊重・指数バックオフ・504 専用扱い・結果キャッシュ（スパイクの `wdqs.ts` がベース）

> 連結率の推移（PR2 実測）: P27のみ 13.4% → 片端日本人 34.4% → seed-traverse 47.7% → +外国人剪定 48.7%。残りは小さな孤立家系で、MVP は「著名人を含む連結コアを渡り歩く」体験で割り切る。
> 注: Wikidata に血縁が無い繋がりは出せない（例: スケーター織田信成 Q708443 は家族関係が未登録で孤立）。製品の約束は「Wikidata が記録する範囲」。

### 公開・ホスティング
- [ ] AuraDB Free へ移行（コンソールで上限確認・接続情報の秘匿）
- [ ] Vercel デプロイ（フロント + API Routes）
- [ ] Neo4j / Wikipedia 取得失敗時のリトライ・フォールバックの作り込み

### 本番前の Neo4j 接続ハードニング（PR1 コードレビューの積み残し）
dev 単一インスタンスでは無害だが、AuraDB（routing クラスタ）移行時に効く。`lib/neo4j.ts` / `app/api/health/route.ts`。
- [ ] driver 生成に `disableLosslessIntegers: true`（Cypher の Integer→JS number 変換をルート側で都度やらない）
- [ ] 読み取りクエリは `session({ defaultAccessMode: neo4j.session.READ })`（クラスタで read replica を使う。現状は既定 WRITE で primary 固定）
- [ ] `closeDriver()` を用意（`next start`・コンテナ・テスト/シーダ等の長命ランタイムでプール解放できるように）
