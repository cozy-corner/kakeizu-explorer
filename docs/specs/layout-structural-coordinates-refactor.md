# 設計: 配置決定を構造座標へ移す（#33）

関連 Issue: [#33](https://github.com/cozy-corner/kakeizu-explorer/issues/33)

## 課題の要約

`lib/layout.ts` の配置ルールが dagre の **pixel 出力**を根拠に判断しており、dagre が本来持つ構造情報（世代・列内順）を pixel から逆算し直す二度手間になっている。これを整数の構造座標 `{generation, order}` の上で書き直し、pixel を最後の射影に隔離する。**機能は不変（描画一致）** のリファクタ。

dagre は「rank と列内 order を返すオラクル」として残す（交差最小化は引き取らない）。order の*生成*は dagre 任せのまま、ドメイン化するのは「pixel 算術 → order 算術」の置き換えと後調整ルールのみ。

## 現状（証拠）

- `Math.round(x)` で世代逆算が4箇所 — `lib/layout.ts:90, 147, 204, 368`
- pixel 行算術 `prevY+row` / `gap>row*1.5` / `±row` — `lib/layout.ts:158-162, 210, 391, 433-437, 520-523`
- 血縁インデックスを各パスが `edges.filter`＋Map で毎回再導出、`coLocatedCouples` は重複呼び出し — `lib/layout.ts:62, 251, 336, 422, 485`
- pixel 定数 `row` を全パスに注入 — `lib/layout.ts:220-232`、`components/GraphPane.tsx:243-249`
- 読み書き境界は既存（再利用可） — `readPositions`/`writePositions` `components/GraphPane.tsx:126-136`
- **x は列で非均一**: 実測（Q319664）で列 x = 8, 244, 487, 730, 966 → 間隔 236/243/243/236。focus(幅30 vs 他16)の両隣だけ 7px 広い（(30-16)/2）。よって `x = generation × 均一stride` では dagre の実 x を再現できず、`EPS=1e-6` の厳密パリティは x で必ず落ちる。

## 提案する変更（3段階・各1PR）

PR は座標を動かさない順に積む。挙動不変の番人（パリティ）を自分で書き換える段階を、座標を動かす段階より前に確定させる。

### PR-A: FamilyGraph 導入（座標不変）

境界で血縁を1回解決し、各パスが読むだけにする。

- `FamilyGraph` 型: `sex` / `fatherOf`（描画上の血統父）/ `trueParentsOf`（母含む真の親）/ `childrenOf` / `spouseOf`（順序保持）/ `adoptiveParentOf`（世代跨ぎのみ）/ `isMarriedIn`。
- `fatherOf`（還元済み）と `trueParentsOf`（未還元）を**両持ち**。`coLocatedCouples` が側室復元に未還元、描画判定に還元済みの**両方**を見ているため、片方に潰すと側室・夫婦中点が壊れる（`lib/layout.ts:334-342`）。
- 養子の2種別分類（世代跨ぎ＝descent / きょうだい間＝家督継承で除外）を構築時の派生として畳み込む（現 `siblingAdoptiveEdges` `lib/graph.ts:98`）。
- 各パスを `(FamilyGraph, …)` 化。`edges.filter` 再導出を排除。**座標表現は据え置き**なので挙動不変を保ちやすい。

### PR-B: Placement `{generation, order}` 化（座標を動かす）

- `readPlacement(pixel→Placement)`: `round(x)` を**1箇所に集約**。`order = y/row` の実数（tuck +1・中点 3.5・dagre の gap を自然表現）。
- pixel 行算術を order 算術へ置換（`prevY+row`→`prevOrder+1`、`gap>row*1.5`→`orderGap>1.5`、`±row`→`±1`）。各パスから `row` 引数を除去。
- `project(Placement→pixel)`: view 所有。x は**列ごとの実 x 写像を保持して射影**（均一 stride は使わない＝非均一を再現）。
- パリティを作り替え（下記）。

### PR-C: 型厳格化

- `PersonId` / `JunctionId` ブランド型（`JUNCTION_PREFIX` 実行時ハック `lib/layout.ts:295` を型で代替）。
- `Kinship`(`PARENT_OF`|`SPOUSE_OF`|`ADOPTIVE_PARENT_OF`) と `SyntheticEdge`(`LAYOUT`|`DESCENT`) を分離。
- `Sex = "male" | "female"`（不明は `undefined`）。
- 連結 id（`${source}|${type}|${target}`）は view 境界に隔離。`lib/layout` は連結キーを扱わない。

## パリティ（非回帰）の方針

x 厳密一致は PR-B で崩れる（列が非均一）。`scripts/layout-parity.ts` を **「列の相対順序 ＋ y(=order×row) 厳密一致 ＋ x は列写像経由で一致」** を検証する形へ作り替える（Issue 完了条件の「同等の保証へ作り替える」）。各段で `scripts/dump-layout.ts` 主要ケース（Q319664 徳川吉宗 等）の描画一致も確認。

## 却下した選択肢

- **couple-merge で dagre 前に順序を確定** — 中点・junction・bow は order 相対量なので原理的に post 残留、かつ cytoscape-dagre が順序制約 API を欠く。#33 の**次**の別 Issue（Issue 末尾「完全自前化」の穏当版）。FamilyGraph と Placement 境界を土台に積めるので #33 が先。
- **均一 stride で x 射影** — 実測非均一（236/243）で描画がずれる。列写像保持を採用。
- **一括1PR** — 5ファイル波及＋型変更で大きすぎ。段階分割。

## リスク / 未確認事項

- PR-B の x 射影は「列→実 x」写像を `readPlacement` で保持すれば厳密一致可能。ただし各パスが列内で x を触らず y のみ動かす前提の確認が要る（`centerOnlyChildren` 等 `lib/layout.ts:527`）。
- `order` 実数化で `tuckChain` の行詰め（`prevOrder+1`）が dagre の gap を保つか、PR-B 着手時に parity で要確認。
- パリティ作り替えは挙動不変の番人を自分で書き換える行為。PR-A（座標不変）を先に通し、PR-B は新パリティ確定後に着手する順序を厳守。

## 波及ファイル

`lib/layout.ts`（全面）/ `lib/graph.ts`（FamilyGraph 構築・型）/ `components/GraphPane.tsx`（境界・射影）/ `scripts/dump-layout.ts` / `scripts/layout-parity.ts`
