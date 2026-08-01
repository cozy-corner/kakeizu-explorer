# 公開タスク: 日本史 家系図エクスプローラー

設計: [2026-06-14-japan-genealogy-explorer-design.md](./2026-06-14-japan-genealogy-explorer-design.md)
MVP: [mvp-tasks.md](./mvp-tasks.md)（本ドキュメントは同ファイル「MVP の外」を実コード・実データ・一次情報で検証して更新したもの）

調査日: 2026-08-01

各タスクの先頭の番号は対応する GitHub issue（#98〜#110）。P3 は公開後の作業なので issue 化していない。

## 前提（確定済み）

- **構成は決定済み**（design doc §2 / §11）: Next.js 一体型を Vercel へ、DB は Neo4j AuraDB Free、Neo4j は必ず API Routes 経由（接続情報をブラウザに晒さない）
- **データ規模**（ローカル Neo4j 実測）: `Person` 38,704 / `PARENT_OF` 32,933・`SIBLING_OF` 10,971・`SPOUSE_OF` 8,606・`ADOPTIVE_PARENT_OF` 2,295（計 54,805 リレーション）
  - design doc §6 の見積もり（コア 19,397 ノード）の約 2 倍。悲観側の上限（50k/175k）でもノード 77%・リレーション 31% で収まるが、余裕は薄い
- **移行経路**: `neo4j-admin database upload --from-path=... --to-uri=neo4j+s://... --to-user --to-password` が Community の dump を Aura へ直接アップロードできる。`scripts/etl-spike/backup-neo4j.sh` と同じワンオフコンテナで実行すればよく、Aura 向けに ETL を再実行する経路は不要

## P0 — 公開のブロッカー

- [ ] #98 Aura インスタンス作成 + **コンソールで実上限を確認**（ノード/リレーション上限、削除ポリシー、同時接続数）。公開情報では確定できないため、ここが起点（下記「調査で確定しなかったこと」）
- [ ] #99 データ移行: dump を作り `neo4j-admin database upload` で Aura へ。移行後に Aura 上でノード数・既知ペアの経路クエリ・性能を検証（ローカル実測値は下記。Aura Free の 1GB インスタンスでは条件が違う）
- [ ] #100 Vercel デプロイ。環境変数は Vercel 側に設定し（`.env.development` はローカル既定値のまま維持）、接続先を `neo4j+s://` に切り替える。Aura は TLS 必須かつルーティングクラスタなので、ローカルの `bolt://localhost:7687` では繋がらない。コード変更は不要で環境変数の値だけだが、**Aura インスタンスが無いと検証できない**ため移行とセットで行う。ドメインとプラン（Hobby は非商用限定）もここで決める
  - 注: `globalThis` への driver キャッシュ（`lib/neo4j.ts`）は Fluid compute 下でも正しい実装なので変更不要
- [ ] #101 モバイル対応。`app/page.tsx` はブレークポイントが実質ゼロで、左右 `w-1/2` 固定の 2 ペイン構成

## P1 — 公開直後に効く

- [ ] #102 レスポンスの CDN キャッシュ。全ルートが `dynamic = "force-dynamic"` のため、Next.js は `private, no-cache, no-store, max-age=0, must-revalidate` を返し、同じ URL でも毎回 Function 起動 → Aura 接続 → Cypher 実行になる。レスポンスは URL だけで決まる純関数（認証もユーザーごとの出し分けも無く、ETL を再実行するまで不変）なので、`Cache-Control: public, s-maxage=...` を付ければエッジで返せる。バースト流入を吸収する主たる手段はこれ
  - `person/[id]/neighbors`（38,704 通り）と `path` は長め、`search`（任意文字列で散る）は短めか無しと、TTL を分ける
- [ ] #103 障害時フォールバック（Neo4j 503 のユーザー向け表示）。**Aura Free は 3 日の無操作で自動ポーズ**するため「DB が寝ている」状態は日常的に起きる
- [ ] #104 エラーモニタリング（現状 `console.error` のみ）
- [ ] #105 運用ガード。Aura の放置対策（自動ポーズ・削除。定期アクセスか再構築手順）と、Vercel の使用量アラート設定（月 100 万 invocation / 4 CPU 時間 / 100GB 転送）。どちらもコードを書かずに済む

## P2 — 体裁

- [ ] #106 メタ情報。`title` が `"kakeizu-explorer"` のまま、OGP 画像なし、favicon は Next デフォルト（`app/layout.tsx`）。`public/` も Next のサンプル SVG が残っている
- [ ] #107 About / 使い方。「Wikidata が記録する範囲」という製品の約束、記事が無い人物が出ること（橋渡し親族の記事被覆率 54.5%）、出典（Wikidata / Wikipedia）、存命人物の扱い（seed-and-traverse は存命者も辿る）
- [ ] #108 `robots.txt` / `sitemap`。クローラー対策としての価値は薄い（下記「やらないと判断したこと」の通り、辿れるリンクが無い）。論点は `/` を検索結果に出すかという SEO のみ

## P3 — 公開後でよい

- [ ] 属性補完（`mvp-tasks.md` PR6 の未完分）。`birth` を持つノードは実測 **0 件**、`wikipediaTitle` は 28,504/38,704（73.6%）
- [ ] ETL の本番化。`scripts/etl-spike/` のままでユニットテストが 1 本も無い。正規化・日本人判定・外国人剪定のテストと再現手順
- [ ] データ更新の運用。更新頻度と、Aura 上での再ロード / バックアップ手順
- [ ] 読み取りセッションを `session({ defaultAccessMode: READ })` に（`lib/api.ts`）。既定は WRITE でクラスタでは primary 固定になるが、**Aura Free は単一インスタンスなので現状の実利はゼロ**。レプリカを持つ構成にスケールしてから

## 公開と独立にできる小改善（環境非依存）

`mvp-tasks.md` の PR1 積み残しのうち、本番環境と無関係でローカルで完結するもの。Aura を待つ理由がなく、CI で検証できる。

- [x] #109 `disableLosslessIntegers: true` をドライバ生成に追加（`lib/neo4j.ts`）。ドライバが `Integer` を返すのはローカルでも本番でも同じで、そのため `.toNumber()` が散っている（`app/api/search/route.ts:37`、`app/api/person/[id]/neighbors/route.ts:101-102`、`app/api/health/route.ts:11` の防御的分岐）。扱うのは件数と次数だけなので桁あふれの心配はない
  - `number` に `.toNumber()` は無いため、フラグ追加と呼び出し側の除去は同一 PR で行う
- [ ] #110 `closeDriver()` を用意（`lib/neo4j.ts`）。Vercel のサーバーレスではプロセスが凍結されるだけで出番が無く、実際に必要なのはローカル側。`scripts/etl-spike/load.ts` と `verify.ts` が `getDriver()` を使いながらプールを閉じる手段を持たない

## やらないと判断したこと

### レート制限（API の流量制御）

公開 API になる以上必要だと当初は考えたが、根拠を一つずつ検証したところ、守るべき具体的なシナリオが残らなかった。

- **「クエリが重いので絞る」は不成立**。ランダムな人物ペアで `/api/path` の Cypher（`PARENT_OF` のみ・`*..60`）を計測すると 7〜50ms。`MAX_HOPS = 60` は一見危ないが、shortestPath は双方向 BFS で連結成分に閉じるため、非連結ペアでも即座に終わる。検索も 12〜36ms
- **「クローラーが全ノードを舐める」は不成立**。ページは `app/page.tsx` の 1 枚のみで人物ごとの URL ルートが無く、`<a href>` も `next/link` もコード中に存在しない。グラフノードは Cytoscape の canvas 描画、検索結果は `<button>` の onClick で、どちらもリンクではない。クローラーが辿れる導線がゼロなので、`/` をレンダリングして終わる。`?id=Q...` もどこからもリンクされておらず発見されない
- **意図的なスクレイピングは動機が無い**。元データは Wikidata の CC0 で公式ダンプが誰でも取得できる。この API を叩く理由がない
- **残る「バズって人が来る」ケースは CDN キャッシュの担当**。流入は著名人に集中するのでキャッシュヒット率が高い

→ 実装ゼロの手段（CDN キャッシュ + Vercel の使用量アラート）で代替する。将来、想定外の流量が実際に観測されたら再検討する。

## 調査で解決したこと（タスクではない）

- **Wikipedia の iframe は本番ドメインでも動く**。`ja.wikipedia.org` のレスポンスに `X-Frame-Options` は無く、CSP にも `frame-ancestors` が無い（ヘッダ実測）。オリジン制限が無いので localhost で動く以上、本番でも動く
- **検索クエリは現時点でインデックス不要**。`/api/search` の Cypher を `PROFILE` した実測（ローカル Docker, 38,704 ノード）:

  | クエリ | Time | DbHits |
  | --- | --- | --- |
  | 徳川 | 36ms | 77,955 |
  | 藤原 | 12ms | 81,741 |
  | 平 | 15ms | 81,103 |
  | 田 | 24ms | 84,421 |

  ラベルの全件スキャンだが数十 ms。全文インデックスは Aura 移行後に再計測してから判断する
- **ライセンス表記は法的義務ではない**。[Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) は構造化データを CC0 とし帰属表示を不要と明記。Wikipedia 本文は CC BY-SA だが、iframe は Wikipedia 自身が配信しており再配布に当たらない。→ 必須タスクではなく About の一行で足りる
- **`mvp-tasks.md` の「WDQS クライアントの本番化」は完了済み**。`scripts/etl-spike/wdqs.ts` に指数バックオフ・Retry-After 尊重・結果キャッシュが実装されている
- **Vercel の実行モデル**。Fluid compute が新規プロジェクトの既定になり、同時リクエストが 1 インスタンスを共有するため、サーバーレスの接続数暴発リスクは大きく下がっている。`@vercel/functions` の `attachDatabasePool` は pg / mysql2 / mongodb / ioredis などが対象で **neo4j-driver は対応リストに無い**ため、互換性未確認のまま採用しない

## 調査で確定しなかったこと（コンソールでの実機確認が必要）

- **AuraDB Free の実上限**。design doc §6 が指摘した公表値の揺れは未解消。FAQ は 200,000 ノード / 400,000 リレーション、製品ページは 50,000 / 175,000、公式技術ドキュメント（neo4j.com/docs/aura）には数値の明記が無い。Neo4j 自身が「コンソールで現在値を確認せよ」としており、他に手段が無い
- **放置による削除までの期間**。「3 日の無操作で自動ポーズ」は複数ソースで一致するが、削除までの期間は情報が割れている（30 日 / 90 日）。いずれにせよ放置すると消える前提で扱う
- **Aura Free の最大同時接続数**。公開ドキュメントに記載が見当たらない
