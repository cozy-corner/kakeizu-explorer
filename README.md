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
