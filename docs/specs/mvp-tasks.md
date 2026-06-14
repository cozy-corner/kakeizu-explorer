# MVP タスク: 日本史 家系図エクスプローラー

設計: [2026-06-14-japan-genealogy-explorer-design.md](./2026-06-14-japan-genealogy-explorer-design.md)

MVP のゴール: **ローカルで動かして、「人物から人物へ渡り歩ける」「2人の経路が出る」を確かめる**。
Vercel / AuraDB などの公開・ホスティングは MVP の外（動くものができてから）。

## 0. 下準備
- [ ] Next.js (TypeScript) スキャフォルド
- [ ] Docker でローカル Neo4j 起動
- [ ] `neo4j-driver` のシングルトン接続ユーティリティ（API Routes 内）

## 1. ETL（クリティカルパス）
- [ ] Wikidata 取得クエリ確定: `P31=Q5 ∧ (P27=Q17 ∪ 出生地日本) ∧ 家族関係あり`（孤立人物は除外＝必須フィルタ）
- [ ] 取得方式の決定: SPARQL 分割取得 or ダンプ抽出（取得安定性で判断）
- [ ] `qid, label, birth, death, image, wikipediaTitle` を取得
- [ ] 親子方向の正規化（P22/P25/P40 → `PARENT_OF`）＋重複排除
- [ ] ローカル Neo4j へロード（`qid` ユニーク制約、エッジ作成）
- [ ] 正規化ロジックのユニットテスト

> 救済（出生地）は正味 +754 人なので、MVP はまず P27 ベースで通し、出生地条件の拡張は後回し可。

## 2. API Routes（3本）
- [ ] `GET /api/search?q=` — 人物名検索
- [ ] `GET /api/person/:id/neighbors?hops=2` — エゴグラフ
- [ ] `GET /api/path?from=&to=` — `shortestPath` で2人の最短経路
- [ ] 3本とも `{ nodes, edges }` 整形 + 結果整形テスト

## 3. UI（2ペイン）
- [ ] 検索ボックス → 人物選択でフォーカス設定
- [ ] 左ペイン: Cytoscape.js エゴグラフ、ノードクリックで再中心化
- [ ] 右ペイン: Wikipedia 記事を REST API 直 fetch、「記事なし」処理
- [ ] 経路探索モード: 2人選択 → 経路ハイライト、「経路が見つかりません」処理

## 4. 検証
- [ ] 既知ペア（信長–家康 等）での経路検証

## MVP の外（公開を決めてから）
- [ ] AuraDB Free へ移行（コンソールで上限確認・接続情報の秘匿）
- [ ] Vercel デプロイ（フロント + API Routes）
- [ ] Neo4j / Wikipedia 取得失敗時のリトライ・フォールバックの作り込み

## リスク低減メモ
ETL が重いので、先にダミー人物を数十件手で Neo4j に入れて API+UI を貫通させ、最後に本番 ETL を流すと UI/API のバグを早く潰せる。
