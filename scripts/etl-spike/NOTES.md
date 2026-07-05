# PR2 ETL スパイク — 結果と判定

使い捨て前提のスパイク。目的は「データとして成立するか・面白いか」を実データで確認し、
PR3 以降に進む価値があるか、そして本番 ETL(PR6) の方式を判定すること。

## 判定: **YES（PR3 へ進む）**。ETL は「属性フィルタ」から「seed-and-traverse」へ転換する。

著名人を含む大きな連結コアが存在し、経路は歴史的に妥当（信長↔家康 3 hops）。概念は成立。
ただし設計 §6 の「P27=日本で母集団を絞る」方式は実在の血縁を切るので採用しない（下記）。

## 再現手順

```bash
docker compose up -d                                   # Neo4j
SPIKE_RELAX=1 bun run scripts/etl-spike/fetch.ts       # E: 種＋1ホップ。全属性を raw-*.json へ
bun run scripts/etl-spike/traverse.ts                  # E: 非日本人フロンティアを1段外へ展開
bun run scripts/etl-spike/transform.ts                 # T: 外国人剪定＋養子分離（WDQS ゼロ・ローカル）
bash scripts/etl-spike/backup-neo4j.sh                  # L の前に現行グラフを .dump へ退避（下記）
bun run scripts/etl-spike/load.ts                      # L: JSON → Neo4j(:Person を毎回リセット)
bun run scripts/etl-spike/verify.ts                    # WCC 連結性 + 既知ペアの shortestPath
bun run scripts/etl-spike/check-wiki.ts                # ja.wikipedia 記事の被覆率
```

## load 前のバックアップ（必須）

`data/` は `.gitignore` 済みで中間 JSON はコミットされない＝**いまの Neo4j グラフを再現できる元データはローカルにしか無い**。`load.ts` は冒頭で `:Person` を `DETACH DELETE` するため、取り込み結果が不正でも戻す手段が無い。Wikidata は日々変わるので同じ入力の再生成も保証できない。よって **load の直前に必ずダンプを取る**。

Neo4j 5 Community は稼働中DBのダンプ不可なので、コンテナを止めて同じボリュームをマウントしたワンオフコンテナで `neo4j-admin database dump` する（`backup-neo4j.sh` がこれを行う）。出力は `scripts/etl-spike/data/backups/`（`data/` ごと gitignore 済み）。

```bash
# バックアップ（backup-neo4j.sh の中身）
docker compose stop neo4j
docker run --rm \
  -v kakeizu_neo4j-data:/data \
  -v "$PWD/scripts/etl-spike/data/backups:/backups" \
  neo4j:5 neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination=true
docker compose up -d neo4j

# 復元（新 ETL の結果が不正だったとき）
docker compose stop neo4j
docker run --rm \
  -v kakeizu_neo4j-data:/data \
  -v "$PWD/scripts/etl-spike/data/backups:/backups" \
  neo4j:5 neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true
docker compose up -d neo4j
```

> #44 で抽出(E)を一元化した。属性（性別 P21・国籍 P27/P27→P17・辺の rank/P1039/P1480・
> 養子 P1038+P1039）は fetch/traverse が発見時に一度だけ取り `raw-*.json` へ永続化し、
> 外国人剪定・養子分離は `transform.ts` が raw をローカル変換するだけ（WDQS 再訪ゼロ）。
> 旧 `filter-foreign.ts` / `fetch-adoptions.ts` / `add-sex.ts` は廃止。

> verify.ts の WCC は GDS を使う。計測時のみ docker-compose の neo4j に `NEO4J_PLUGINS: '["graph-data-science"]'` を足して `docker compose up -d` で再生成する（本番アプリは GDS 不要なので既定では入れない）。

データ取得は WDQS(SPARQL)。共有クライアント `wdqs.ts`（POST・指数バックオフ+ジッター・
Retry-After 尊重・結果キャッシュ）。重いクエリは 504 になるので `VALUES ?p` で軽量化が必要。

## 連結率の推移（2026-06-14 実測）— ETL 方式ごと

| 方式                             | ノード | 最大連結成分(WCC) | 信長の祖先深さ | 問題                    |
| -------------------------------- | ------ | ----------------- | -------------- | ----------------------- |
| ① P27=Q17 のみ（設計どおり）     | 17,171 | **13.4%**         | 2 世代         | 実在の血縁が切れる      |
| ② 辺の片端が日本人               | 27,247 | 34.4%             | 2 世代         | 祖先が浅い              |
| ③ seed-and-traverse（種から1段） | 32,216 | 47.7%             | **16 世代**    | 世界系図へ漏れる        |
| ④ ③＋外国人剪定                  | 31,492 | **48.7%**         | 16 世代        | 漏れ解消・日本人維持 ✅ |

### 経路の質（shortestPath, 無向）

| ペア                    | 結果       | 備考                                                                                                           |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| 昭和天皇 ↔ 明仁         | 1 hop      | 親子サニティ                                                                                                   |
| **信長 ↔ 家康（目玉）** | **3 hops** | `信長→徳姫=松平信康←家康`。婚姻同盟。歴史的に正しい＝意味のある経路                                            |
| 家康 ↔ 秀吉             | 2 hops     | 朝日姫経由                                                                                                     |
| 信長 ↔ 頼朝             | 11 hops    | ※別氏族・約400年差。婚姻の連鎖で繋がるだけで**血縁ではない**。繋がらなくても自然で、連結の成否指標としては弱い |

## 主要な発見

1. **P27フィルタは実在の血縁を切る。** 信長の父系は Wikidata に 13 人の祖先がいて 11 人に
   ja 記事があるが、P27=日本タグを持つのは信秀ただ1人。設計どおり P27 で絞ると祖先は
   2 世代で途切れる。中世人は国民国家以前で国籍が振られていないため。
2. **seed-and-traverse で解決。** 日本人を種に家族関係を国籍無視で辿ると、P27 タグの無い
   橋渡し親族（「○○の娘」級）が入り、既にグラフ内にありながら分断されていた巨大な祖先網
   （京極/佐々木/二階堂/藤原…）と一気に繋がる。信長の祖先が 2→16 世代に。
3. **無制限に辿ると世界系図へ漏れる。** オノ・ヨーコ(日本人)→夫ジョン・レノン→レノン家、と
   外国系図が混入し信長↔レノンが連結してしまう。**バウンドが必須。**
4. **外国人剪定で漏れだけ除去できる（ユーザー案）。** 「国籍を持つが日本が一つも無い」を除去。
   ただし**「日本」は広義に**: `P27=Q17` または `P27→P17=日本`（江戸幕府・大日本帝国・
   鎌倉/室町幕府などの歴史的国家は P17=日本 を持つ）。P27=Q17 のみだと於大の方・愛姫
   （P27=江戸幕府）を誤って外国扱いする。**出生地(P19→P17)は古い土地で不安定なので使わない。**
   結果: レノン除去・於大/愛姫維持・連結率 48.7% 維持。
5. **ソース欠落は ETL では直せない（種類B）。** スケーター織田信成(Q708443)は P27=日本だが
   家族関係が Wikidata に未登録＝孤立。有名な傍系子孫の話も encode されていない。
   製品の約束は「Wikidata が記録する範囲を渡り歩ける」であり完全な家系ではない。
6. **右ペインの記事被覆率。** 日本人コア 95.4%／橋渡し親族 54.5% に ja 記事あり。
   橋渡しの約半数は「記事なし」表示になる（外国人婚入者＋古代の無名女性）。
7. **無料枠に収まる。** ④でも 31,492 ノード／約 4 万エッジ。悲観上限(5万/17.5万)でも余裕。

## 確定した PR6 の ETL 設計（3段）

1. **種**: `P27=Q17` または `P27→P17=日本`。
2. **探索**: 種から P22/P25/P40/P26/P3373 を国籍無視で辿り、橋渡し親族を回収。
3. **剪定**: 「国籍ありで日本(広義)が一つも無い」ノードを除去（出生地は不使用）。

> 残り約半分は小さな孤立家系。MVP は「著名人を含む連結コアを渡り歩く」体験で割り切る。
> さらなる連結性向上は MVP 後の改善余地。
