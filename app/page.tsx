"use client";

import { useCallback, useRef, useState } from "react";
import { ArticlePane } from "@/components/ArticlePane";
import { GraphPane, type FocusPerson } from "@/components/GraphPane";
import type { Graph } from "@/lib/graph";

export default function Home() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusPerson | null>(null);
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
      setResults((await res.json()) as Graph);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "検索に失敗しました");
      setResults(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  // Stable identity so GraphPane's cytoscape effect doesn't rebuild on every
  // parent render (it lists onSelect as a dependency).
  const selectPerson = useCallback((person: FocusPerson) => {
    setFocus(person);
    setResults(null);
  }, []);

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h1 className="text-lg font-semibold tracking-tight">
          家系図エクスプローラー
        </h1>
        <form onSubmit={search} className="flex flex-1 gap-2 sm:max-w-md">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="人物名で検索（例: 織田信長）"
            aria-label="人物名で検索"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            検索
          </button>
        </form>
      </header>

      {loading && <p className="px-4 py-2 text-sm text-zinc-500">検索中…</p>}
      {error && <p className="px-4 py-2 text-sm text-red-600">{error}</p>}
      {results && (
        <ul className="max-h-64 overflow-auto border-b border-zinc-200 dark:border-zinc-800">
          {results.nodes.length === 0 && (
            <li className="px-4 py-2 text-sm text-zinc-500">
              該当する人物が見つかりません
            </li>
          )}
          {results.nodes.map((node) => (
            <li key={node.qid}>
              <button
                onClick={() => selectPerson(node)}
                className="w-full px-4 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                {node.label}{" "}
                <span className="text-sm text-zinc-400">{node.qid}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <main className="flex min-h-0 flex-1">
        {focus ? (
          <>
            <section className="w-1/2 border-r border-zinc-200 dark:border-zinc-800">
              <GraphPane
                key={focus.qid}
                focus={focus}
                onSelect={selectPerson}
              />
            </section>
            <section className="w-1/2 overflow-auto">
              <ArticlePane key={focus.qid} title={focus.label} />
            </section>
          </>
        ) : (
          <p className="m-auto text-zinc-500">
            人物を検索して選択すると家系グラフと記事を表示します
          </p>
        )}
      </main>
    </div>
  );
}
