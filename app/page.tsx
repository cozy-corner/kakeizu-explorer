"use client";

import { useState } from "react";
import type { Graph } from "@/lib/graph";

export default function Home() {
  const [query, setQuery] = useState("");
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`検索に失敗しました (${res.status})`);
      setGraph((await res.json()) as Graph);
    } catch (err) {
      setError(err instanceof Error ? err.message : "検索に失敗しました");
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        家系図エクスプローラー
      </h1>

      <form onSubmit={search} className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="人物名で検索（例: 織田信長）"
          aria-label="人物名で検索"
          className="flex-1 rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          検索
        </button>
      </form>

      {loading && <p className="text-zinc-500">検索中…</p>}
      {error && <p className="text-red-600">{error}</p>}

      {graph && !loading && !error && (
        <ul className="flex flex-col gap-1">
          {graph.nodes.length === 0 && (
            <li className="text-zinc-500">該当する人物が見つかりません</li>
          )}
          {graph.nodes.map((node) => (
            <li
              key={node.qid}
              className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
            >
              {node.label}{" "}
              <span className="text-sm text-zinc-400">{node.qid}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
