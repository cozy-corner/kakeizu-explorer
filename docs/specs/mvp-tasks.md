# MVP タスク: 日本史 家系図エクスプローラー

設計: [2026-06-14-japan-genealogy-explorer-design.md](./2026-06-14-japan-genealogy-explorer-design.md)

MVP のゴール: **ローカルで動かして、「人物から人物へ渡り歩ける」「2人の経路が出る」を確かめる**。
Vercel / AuraDB などの公開・ホスティングは MVP の外（動くものができてから）。

方針: **一番不確実な ETL（データ）を最優先で潰す**。UI/API は既知の手堅い技術なので後回しでよい。
各見出しがおおよそ 1 PR の単位。

## PR1. 基盤
- [ ] Docker でローカル Neo4j 起動（データを置く器）
- [ ] Next.js (TypeScript) スキャフォルド
- [ ] `neo4j-driver` のシングルトン接続ユーティリティ（API Routes 内）

## PR2. ETL スパイク（最優先 / 使い捨て前提・不確実性を殺す）
きれいに作らない。「データとして成立するか・面白いか」だけを最短で確認する。
- [ ] Wikidata から実データを一度取得（`P31=Q5 ∧ (P27=Q17 ∪ 出生地日本) ∧ 家族関係あり`、孤立人物は除外）
- [ ] 親子方向だけ最低限正規化してローカル Neo4j にロード
- [ ] Neo4j Browser で手 Cypher 検証:
  - [ ] **連結性**: 最大連結成分はノードの何割か
  - [ ] **経路の質**: `shortestPath(信長, 家康)` 等の既知ペアを手で叩き、経路が出るか・妥当か
- [ ] 判定: YES なら PR3 へ / NO なら作るべきか再考（手戻り最小）

## PR3. 貫通の最小（検索）
- [ ] `GET /api/search?q=` — 人物名検索（`{ nodes, edges }` 整形 + テスト）
- [ ] 検索ボックスだけの UI → 端から端まで通ることを確認

## PR4. エゴグラフ（渡り歩き）
- [ ] `GET /api/person/:id/neighbors?hops=2`（+ テスト）
- [ ] 左ペイン: Cytoscape.js エゴグラフ、ノードクリックで再中心化
- [ ] 右ペイン: Wikipedia 記事を REST API 直 fetch、「記事なし」処理

## PR5. 経路探索（目玉機能）
- [ ] `GET /api/path?from=&to=` — `shortestPath`（+ テスト）
- [ ] 経路探索モード: 2人選択 → 経路ハイライト、「経路が見つかりません」処理

## PR6. ETL の本番化
- [ ] 取得方式の確定: SPARQL 分割取得 or ダンプ抽出（取得安定性で判断）
- [ ] `qid, label, birth, death, image, wikipediaTitle` を全件取得
- [ ] 親子方向の正規化（P22/P25/P40 → `PARENT_OF`）＋重複排除を実装に固める
- [ ] 正規化ロジックのユニットテスト
- [ ] `qid` ユニーク制約・全件ロードの再現可能な手順化

> 救済（出生地）は正味 +754 人なので、まず P27 ベースで通し、出生地条件の拡張は後回し可。

## MVP の外（公開を決めてから）
- [ ] AuraDB Free へ移行（コンソールで上限確認・接続情報の秘匿）
- [ ] Vercel デプロイ（フロント + API Routes）
- [ ] Neo4j / Wikipedia 取得失敗時のリトライ・フォールバックの作り込み

### 本番前の Neo4j 接続ハードニング（PR1 コードレビューの積み残し）
dev 単一インスタンスでは無害だが、AuraDB（routing クラスタ）移行時に効く。`lib/neo4j.ts` / `app/api/health/route.ts`。
- [ ] driver 生成に `disableLosslessIntegers: true`（Cypher の Integer→JS number 変換をルート側で都度やらない）
- [ ] 読み取りクエリは `session({ defaultAccessMode: neo4j.session.READ })`（クラスタで read replica を使う。現状は既定 WRITE で primary 固定）
- [ ] `closeDriver()` を用意（`next start`・コンテナ・テスト/シーダ等の長命ランタイムでプール解放できるように）
