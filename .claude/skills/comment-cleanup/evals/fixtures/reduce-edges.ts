import type { Edge, PersonId } from "./graph";

export function patrilinealEdges(edges: Edge[]): Edge[] {
  // 結果を貯める配列
  const out: Edge[] = [];

  // すべての辺をループする
  for (const e of edges) {
    // 養子辺の向きは P1039 のロールが正本なので、それを見て判定する。
    // carrier プロパティ側で上書きすると向きを誤るため参照しない。
    if (e.role === "P1039" && e.reversed) continue;

    // 父が複数いる子（諸説・落胤説）は血統橋を作ってしまうので落とす
    if (e.disputed) continue;

    // 辺を追加する
    out.push(e);
  }

  return out;
}

// 家督（相続）の辺: 血のつながった兄弟間の養子縁組で、descent ではない。
// レイアウト上はランク付けにも描画にも出したくないので後段で除外する。
export function siblingAdoptiveEdges(edges: Edge[]): Set<PersonId> {
  const drop = new Set<PersonId>();
  for (const e of edges) {
    // 兄弟養子かどうかを判定
    if (e.role === "P1039" && e.sharesBloodParent) drop.add(e.child);
  }
  return drop;
}
