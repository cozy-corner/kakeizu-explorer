# kakeizu-explorer

日本の歴史上の人物の家系を、人物から人物へ渡り歩いて探索する Web サービス。
左に家系グラフ、右にフォーカス中の人物の Wikipedia 記事を表示する。

設計: `docs/specs/`

## ローカル開発

```bash
# 1. 依存インストール
bun install

# 2. Neo4j 起動（Browser: http://localhost:7474 / Bolt: 7687）
docker compose up -d

# 3. Next.js 起動
bun run dev
```

疎通確認: `curl http://localhost:3000/api/health` → `{"status":"ok","neo4j":1}`

- グラフDB: Neo4j 5（Docker, `docker-compose.yml`）。本番は AuraDB を想定。
- Neo4j 接続: `lib/neo4j.ts`（Driver シングルトン、API Routes からのみ利用）。
- 環境変数: ローカル既定値は `.env.development`（コミット済み・非秘密）に入っており `bun run dev` が自動で読む。本番値は Vercel の環境変数で上書きする。個人の上書きが必要なら `.env.local`（gitignore）を作る。

## レイアウト診断

家系グラフのノード配置や descent 線の折れを、ブラウザを操作せず**数値で**確認するツール。dagre は決定論的なので、headless で同じ入力を流せばブラウザと同一座標を再現できる（`GraphPane` のレイアウト手順をそのまま再現）。

```bash
# dev サーバー起動中に実行（QID 省略時は徳川吉宗 Q319664）
bun run scripts/dump-layout.ts Q319664
```

出力されるもの:

- **Nodes** — 各ノードの `x, y`（`x` ＝世代の列）
- **Dropped non-descent adoptions** — 兄弟間の養子（血縁の親を共有する家督継承）は descent でないため edges から除外され描画もランク付けもされない。該当時のみ表示
- **Drawn descent lines** — 各 descent 線の taxi 経路と `[cols=列スパン, bends=折れ数]`。`cols≥2` は世代配置の異常（線が余計な列を横断して折れる）のサイン
- **Descent junctions** — 夫婦の中点から子へ伸びる線の起点と `dy`
- **Spouse detours** — 迂回（bow）するマリッジ線

純粋なレイアウト関数（`lib/layout`）の非回帰チェックは `bun test lib/layout.test.ts`。実 ego グラフの dagre 出力を `lib/fixtures/layout/*.json` に凍結した golden テストで、DB・dev サーバー不要・CI 実行可。フィクスチャは dev サーバー起動中に `bun run scripts/gen-layout-fixtures.ts` で再生成する。
