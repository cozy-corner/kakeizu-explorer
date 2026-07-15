"use client";

import { useCallback, useRef, useState } from "react";
import { ArticlePane } from "@/components/ArticlePane";
import { GraphPane, type FocusPerson } from "@/components/GraphPane";
import type { SearchResult } from "@/lib/graph";

export default function Home() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The ego view's anchor: the layout root, fixed until a new search selection.
  const [focus, setFocus] = useState<FocusPerson | null>(null);
  // The read target: the last-fired person in the ego view (drives the article).
  // Separate from the anchor so moving/firing changes the article without re-rooting.
  const [current, setCurrent] = useState<FocusPerson | null>(null);
  // When set, the left pane shows the shortest path from `focus` to this person.
  const [pathTarget, setPathTarget] = useState<FocusPerson | null>(null);
  // Overlay the adoption layer (養子・養父) on the ego graph. Default off = blood
  // only. Held here, not in GraphPane, so it survives GraphPane's focus/path remount.
  const [showAdoptions, setShowAdoptions] = useState(false);
  // Latest-wins: a fast re-search must not let a stale response overwrite newer results.
  const searchAbort = useRef<AbortController | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`検索に失敗しました (${res.status})`);
      setResults((await res.json()) as SearchResult);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "検索に失敗しました");
      setResults(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  // Stable identity so GraphPane's cytoscape effect doesn't rebuild on every
  // parent render (it lists these callbacks as dependencies).
  // Choosing a person re-roots the ego view: new anchor and, until it fires, its
  // own current. Also leaves path mode (a path node tap re-anchors the same way).
  const selectPerson = useCallback((person: FocusPerson) => {
    setFocus(person);
    setCurrent(person);
    setPathTarget(null);
    setResults(null);
  }, []);

  // The ego view reports its read target (last fired) here; it never re-anchors.
  const showCurrent = useCallback((person: FocusPerson) => {
    setCurrent(person);
  }, []);

  const choosePathTarget = useCallback((person: FocusPerson) => {
    setPathTarget(person);
    setResults(null);
  }, []);

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="border-rule flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h1 className="font-display text-xl font-semibold tracking-wide">
          家系図エクスプローラー
        </h1>
        <form onSubmit={search} className="flex flex-1 gap-2 sm:max-w-md">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="人物名で検索（例: 織田信長）"
            aria-label="人物名で検索"
            className="border-rule-strong flex-1 rounded-md border bg-white/60 px-3 py-1.5"
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-ink text-washi rounded-md px-4 py-1.5 disabled:opacity-50"
          >
            検索
          </button>
        </form>
      </header>

      {loading && <p className="text-muted px-4 py-2 text-sm">検索中…</p>}
      {error && <p className="text-vermilion px-4 py-2 text-sm">{error}</p>}
      {results && (
        <ul className="border-rule max-h-64 overflow-auto border-b">
          {results.nodes.length === 0 && (
            <li className="text-muted px-4 py-2 text-sm">
              該当する人物が見つかりません
            </li>
          )}
          {results.total > results.nodes.length && (
            <li className="border-panel-rule bg-panel text-muted border-b px-4 py-2 text-sm">
              {results.total} 件ヒット。関連度の高い上位 {results.nodes.length}{" "}
              件を表示中。名前を絞り込んでください。
            </li>
          )}
          {results.nodes.map((node) => (
            <li key={node.qid} className="flex items-center">
              <button
                onClick={() => selectPerson(node)}
                className="hover:bg-tint flex-1 px-4 py-2 text-left"
              >
                {node.label}{" "}
                <span className="text-faint text-sm">{node.qid}</span>
              </button>
              {focus && node.qid !== focus.qid && (
                <button
                  onClick={() => choosePathTarget(node)}
                  title={`${focus.label} からの経路を表示`}
                  className="border-rule-strong text-muted hover:bg-tint mr-2 shrink-0 rounded-md border px-2 py-1 text-xs"
                >
                  ⇄ 経路
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <main className="flex min-h-0 flex-1">
        {focus ? (
          <>
            <section className="border-rule flex w-1/2 flex-col border-r">
              {pathTarget && (
                <div className="border-rule flex items-center gap-2 border-b px-3 py-2 text-sm">
                  <span className="truncate">
                    経路: <strong>{focus.label}</strong> →{" "}
                    <strong>{pathTarget.label}</strong>
                  </span>
                  <button
                    onClick={() => setPathTarget(null)}
                    className="border-rule-strong hover:bg-tint ml-auto shrink-0 rounded-md border px-2 py-0.5 text-xs"
                  >
                    エゴ表示に戻る
                  </button>
                </div>
              )}
              {!pathTarget && (
                <label className="border-rule flex items-center gap-2 border-b px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={showAdoptions}
                    onChange={(e) => setShowAdoptions(e.target.checked)}
                  />
                  養子・養父を表示
                </label>
              )}
              <div className="relative min-h-0 flex-1">
                <GraphPane
                  key={`${focus.qid}:${pathTarget?.qid ?? ""}`}
                  focus={focus}
                  pathTo={pathTarget}
                  showAdoptions={showAdoptions}
                  onSelect={selectPerson}
                  onCurrent={showCurrent}
                />
              </div>
            </section>
            <section className="w-1/2 overflow-auto">
              {/* Path mode reads the destination; ego mode reads the current
                  (last-fired) person, falling back to the anchor before the first
                  fire. Stateless iframe: changing person navigates it in place. */}
              <ArticlePane person={pathTarget ?? current ?? focus} />
            </section>
          </>
        ) : (
          <p className="text-muted m-auto">
            人物を検索して選択すると家系グラフと記事を表示します
          </p>
        )}
      </main>
    </div>
  );
}
