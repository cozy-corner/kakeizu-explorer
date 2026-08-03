# 公開タスク: 日本史 家系図エクスプローラー

設計: [2026-06-14-japan-genealogy-explorer-design.md](./2026-06-14-japan-genealogy-explorer-design.md)
MVP: [mvp-tasks.md](./mvp-tasks.md)（本ドキュメントは同ファイル「MVP の外」を実コード・実データ・一次情報で検証して更新したもの）

調査日: 2026-08-01

各タスクの先頭の番号は対応する GitHub issue（#98〜#110）。P3 は公開後の作業なので issue 化していない。

## 前提（確定済み）

- **構成は決定済み**（design doc §2 / §11）: Next.js 一体型を Vercel へ、DB は Neo4j AuraDB Free、Neo4j は必ず API Routes 経由（接続情報をブラウザに晒さない）
- **データ規模**（ローカル Neo4j 実測）: `Person` 38,704 / `PARENT_OF` 32,933・`SIBLING_OF` 10,971・`SPOUSE_OF` 8,606・`ADOPTIVE_PARENT_OF` 2,295（計 54,805 リレーション）
  - design doc §6 の見積もり（コア 19,397 ノード）の約 2 倍。**Free の実上限 200k/400k（コンソールで確認済み、下記）に対してノード 19%・リレーション 14%** で、余裕は十分
- **移行経路**: `neo4j-admin database upload --from-path=... --to-uri=neo4j+s://... --to-user --to-password` が Community の dump を Aura へ直接アップロードできる。`scripts/etl-spike/backup-neo4j.sh` と同じワンオフコンテナで実行すればよく、Aura 向けに ETL を再実行する経路は不要

## P0 — 公開のブロッカー

- [x] #98 Aura インスタンス作成 + **コンソールで実上限を確認**（結果は下記「コンソールで確認済み」。同時接続数のみ記載が無く未確定）
- [x] #99 データ移行: dump を作り `neo4j-admin database upload` で Aura へ。件数一致・既知ペアの経路・応答時間を Aura 上で検証済み（下記「Aura 上での実測」）
  - `backup-neo4j.sh` は `docker compose -f` が OrbStack 環境で動かない（`unknown shorthand flag: 'f'`）。今回は `docker stop` / `docker start` に読み替えて実行した
- [x] #100 Vercel デプロイ。環境変数を Vercel 側に設定し（`.env.development` はローカル既定値のまま維持）、`vercel.json` に `"regions": ["sin1"]` を置いて Aura と同居させた。本番は https://kakeizu-explorer.vercel.app（チーム `kakeizu` / Hobby）。実測は下記「本番での実測」
  - 注: `globalThis` への driver キャッシュ（`lib/neo4j.ts`）は Fluid compute 下でも正しい実装なので変更不要
  - ドメインの判断は #116 へ分離した。`*.vercel.app` で公開は成立し、後から足しても既存 URL は壊れないためブロッカーではない
- [ ] #101 モバイル対応。`app/page.tsx` はブレークポイントが実質ゼロで、左右 `w-1/2` 固定の 2 ペイン構成

## P1 — 公開直後に効く

- [x] #102 レスポンスの CDN キャッシュ。成功レスポンスに `CDN-Cache-Control` を付けた（`lib/api.ts` の `cdnCache()`）。`neighbors` / `path` / `person/[id]` は CDN 1 日 + SWR 7 日、`search` は 1 時間 + SWR 1 日。`/api/health` と 404 / 503 は `no-store`
  - ブラウザ向けの `Cache-Control` と CDN 向けを分けた。ブラウザも `stale-while-revalidate` を解釈するため、共通ヘッダだと再デプロイ後も訪問者自身のキャッシュが最大 7 日前のデータを返しうる。Vercel では `CDN-Cache-Control` が `Cache-Control` を**常に**上書きする（[docs](https://vercel.com/docs/caching/cache-control-headers)）
  - `force-dynamic` のままでも自前の `Cache-Control` は Next に上書きされない（production build で実測）。Next はエラー応答に `Cache-Control` を一切付けないため、`no-store` は明示が必要だった
  - **本番での `x-vercel-cache: HIT` は未実測**。ローカルの `next start` に CDN は無いので、デプロイ後に `curl -sSI` で確認する
  - 未着手: `stale-if-error`。Aura が寝ている間 CDN が古い応答を返せるので #103 と一緒に検討する
- [ ] #103 障害時フォールバック（Neo4j 503 のユーザー向け表示）。**Aura Free は 3 日の無操作で自動ポーズ**するため「DB が寝ている」状態は日常的に起きる
- [ ] #104 エラーモニタリング（現状 `console.error` のみ）
- [ ] #105 運用ガード。Aura の放置対策（自動ポーズ・削除。定期アクセスか再構築手順）と、Vercel の使用量アラート設定（月 100 万 invocation / 4 CPU 時間 / 100GB 転送）。どちらもコードを書かずに済む

## P2 — 体裁

- [ ] #106 メタ情報。`title` が `"kakeizu-explorer"` のまま、OGP 画像なし、favicon は Next デフォルト（`app/layout.tsx`）。`public/` も Next のサンプル SVG が残っている
- [ ] #107 About / 使い方。「Wikidata が記録する範囲」という製品の約束、記事が無い人物が出ること（橋渡し親族の記事被覆率 54.5%）、出典（Wikidata / Wikipedia）、存命人物の扱い（seed-and-traverse は存命者も辿る）
- [ ] #116 公開ドメインを決める（#100 から分離）。独自ドメインを取るか `*.vercel.app` のままにするか。プラン（Hobby は非商用限定）の判断と重なる
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

  ラベルの全件スキャンだが数十 ms。**Aura 移行後に再計測して、全文インデックスは不要と確定した**（下記）
- **ライセンス表記は法的義務ではない**。[Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing) は構造化データを CC0 とし帰属表示を不要と明記。Wikipedia 本文は CC BY-SA だが、iframe は Wikipedia 自身が配信しており再配布に当たらない。→ 必須タスクではなく About の一行で足りる
- **`mvp-tasks.md` の「WDQS クライアントの本番化」は完了済み**。`scripts/etl-spike/wdqs.ts` に指数バックオフ・Retry-After 尊重・結果キャッシュが実装されている
- **Vercel の実行モデル**。Fluid compute が新規プロジェクトの既定になり、同時リクエストが 1 インスタンスを共有するため、サーバーレスの接続数暴発リスクは大きく下がっている。`@vercel/functions` の `attachDatabasePool` は pg / mysql2 / mongodb / ioredis などが対象で **neo4j-driver は対応リストに無い**ため、互換性未確認のまま採用しない

## コンソールで確認済み（#98）

Aura コンソールのインスタンス作成画面に表示された Free プランの記載:

- **上限は 200,000 ノード / 400,000 リレーション**。公表値の揺れ（FAQ の 200k/400k と製品ページの 50k/175k）は **FAQ 側が正しい**と確定。悲観側の 50k/175k を前提にした余裕の薄さは解消された
- **無操作 30 日で自動削除**。割れていた情報（30 日 / 90 日）は 30 日が正
- メモリ・vCPU は "Limited"（数値の記載なし）、バックアップも "Limited"
- **プロバイダ / リージョンは選択できず固定**。作成されたインスタンスは **GCP シンガポール (asia-southeast1)**。コンソールに表示が無いため接続ホストの名前解決から判定した（`34.126.114.186` → `*.bc.googleusercontent.com`、Google 公開 IP レンジの `34.126.64.0/18` = asia-southeast1）
  - → **Vercel の関数リージョンは `sin1`**（ap-southeast-1）を指定し、関数と DB を同居させる（#100）。東京 `hnd1` だと 1 リクエストあたりの Cypher 実行回数だけ東京↔シンガポール（RTT 約 70ms）を往復する
  - ただし **Free の配置は公表も保証もされていない**。公式ドキュメントのリージョン一覧（[neo4j/docs-aura](https://github.com/neo4j/docs-aura) の `data/regions.json`）はティア別提供状況を持つが Free の項目自体が無く、コンソールのインスタンス一覧も Region 欄が空。`sin1` 指定は保証ではなく実測に基づく最適化であり、外れても壊れず遅くなるだけ。デプロイ後に遅い場合はホスト名を引き直して配置が変わっていないか確認する

作成時の注意: 既定の導線では **Professional の 14 日トライアル**（2GB メモリ / 4GB ストレージ、ノード上限の概念なし、こちらはプロバイダ/リージョンを選べる）が作られることがある。プラン選択で Free を明示すること。

## Aura 上での実測（#99 移行後）

`neo4j-admin database upload` で dump をアップロードし、件数・経路・応答時間を検証した。

- **件数はローカルと完全一致**（`Person` 38,704 / `PARENT_OF` 32,933 / `SIBLING_OF` 10,971 / `SPOUSE_OF` 8,606 / `ADOPTIVE_PARENT_OF` 2,295）。`person_qid` の RANGE インデックスも dump 経由で引き継がれる
- **応答時間はローカル開発機（日本）から測って 88〜125ms**。ただしその大半は東京↔シンガポールの往復で、DB をほとんど使わない `/api/health` が 88ms。**これを差し引いた実質のクエリ時間はローカル Docker と同等**（`/api/search` 約 25ms、`/api/path` 数 ms）。Free の 1GB インスタンスでも性能は落ちていない

  | エンドポイント | 実測 | health(88ms) 差し引き |
  | --- | --- | --- |
  | `/api/health` | 88ms | — |
  | `/api/search?q=徳川` | 117〜126ms | 約 30ms |
  | `/api/search?q=田`（3,481 件） | 111〜117ms | 約 25ms |
  | `/api/path` 家康→慶喜（9 hop） | 90〜94ms | 数 ms |
  | `/api/path` 道長→家康（20 hop） | 100〜107ms | 約 15ms |
  | `/api/person/{qid}` | 88〜91ms | 数 ms |
  | `/api/person/{qid}/neighbors` | 103〜113ms | 約 20ms |

  Vercel の関数を `sin1` に置けばこの 88ms は消えるため、本番の実効レイテンシはローカル Docker 相当になる見込み

- **既知ペアの経路が期待どおり返る**。徳川家康 → 徳川慶喜 は血縁のみで 9 hop（秀忠 → 和子 → 女二宮 → 後水尾天皇 → 霊元天皇 → 有栖川宮職仁親王 → 織仁親王 → 吉子女王 → 慶喜）。慶喜の生母が有栖川宮家出身という史実と一致する

## 本番での実測（#100 デプロイ後）

`https://kakeizu-explorer.vercel.app` に対して東京の開発機から計測（各 3 回）。

- **`sin1` 指定は効いている**。`x-vercel-id: hnd1::sin1::…` で、東京の PoP から入り実行はシンガポールであることを確認した。Aura Free が asia-southeast1 に居るという #98 の推定は、少なくとも現時点では外れていない
- **関数↔DB の往復は消えた**。`/api/health` の 145ms は日本↔シンガポールの往復で、これを差し引いた各エンドポイントの値は #99 のローカル実測とほぼ一致する

  | エンドポイント | 実測 | health(145ms) 差し引き |
  | --- | --- | --- |
  | `/api/health` | 146 / 144 / 153ms | — |
  | `/api/search?q=徳川` | 171 / 167 / 171ms | 約 25ms |
  | `/api/search?q=田` | 180 / 190 / 229ms | 約 40ms |
  | `/api/person/Q171977` | 170 / 173 / 140ms | 数 ms |
  | `/api/person/Q171977/neighbors` | 175 / 155 / 342ms | 約 20ms |
  | `/api/path` 家康→慶喜 | 204 / 165 / 138ms | 数 ms |
  | `/api/path` 道長→家康 | 165 / 151 / 147ms | 数 ms |

- **コールドスタートは初回 874ms**。#103 のフォールバック表示と合わせて、体感の初回応答はここが支配的になる
- **経路は Aura 上の検証と一致**。家康→慶喜 が 9 hop で同じ経路を返す
- **Wikipedia の iframe は本番ドメインでも実際に描画された**（ヘッダからの推定どおり）。実ブラウザで検索→人物選択まで通し、グラフと記事の両方が出ることを確認。コンソールエラーは Wikipedia 側の警告 1 件のみ

## 調査で確定しなかったこと

- **Aura Free の最大同時接続数**。公開ドキュメントにもコンソールにも記載が見当たらない
- **自動ポーズまでの期間**。「3 日の無操作で自動ポーズ」は複数ソースで一致するが、コンソールの Free プラン説明に記載があるのは削除（30 日）のみ
