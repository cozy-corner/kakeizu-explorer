"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { ArticlePane } from "@/components/ArticlePane";
import { GraphPane, type FocusPerson } from "@/components/GraphPane";
import { ServiceNotice } from "@/components/ServiceNotice";
import { ApiError, fetchJson, isUnavailable, toError } from "@/lib/apiFetch";
import type { SearchResult } from "@/lib/graph";

function GraphToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="border-rule flex items-center gap-2 border-b px-3 py-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function PaneTab({
  label,
  hint,
  active,
  controls,
  onSelect,
}: Readonly<{
  label: string;
  hint?: string;
  active: boolean;
  controls: string;
  onSelect: () => void;
}>) {
  return (
    <button
      type="button"
      // Toggle buttons, not role="tab": the switcher is md:hidden while the panes
      // persist at every width, so tab/tabpanel would name a tablist that isn't there.
      aria-pressed={active}
      aria-controls={controls}
      onClick={onSelect}
      className={`-mb-px flex min-w-0 flex-1 items-baseline justify-center gap-1.5 border-b-2 px-4 py-2 text-sm ${
        active ? "border-ink font-semibold" : "text-muted border-transparent"
      }`}
    >
      {label}
      {hint && <span className="text-faint truncate text-xs">{hint}</span>}
    </button>
  );
}

export default function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Read `?id=` from the search-params prop (not window.location): resolved on
  // the server too, so a deep link renders its loading state in the first paint
  // — no flash of the empty-state prompt, no hydration mismatch.
  const idParam = use(searchParams).id;
  const deepLinkId = typeof idParam === "string" ? idParam.trim() : "";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{
    error: Error;
    retry: () => void;
  } | null>(null);
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
  // Scopes the path search only; the ego graph always draws marriages.
  const [includeSpouses, setIncludeSpouses] = useState(false);
  // Which pane the narrow (< md) layout shows. Both panes stay mounted and are
  // hidden with CSS — unmounting the graph would drop the exploration cytoscape
  // has accumulated inside GraphPane, along with the camera.
  const [mobilePane, setMobilePane] = useState<"graph" | "article">("graph");
  // Latest-wins: a fast re-search must not let a stale response overwrite newer results.
  const searchAbort = useRef<AbortController | null>(null);
  // Starts true when a `?id=` deep link is present so the pane shows a loader
  // (not the empty-state prompt) from the first render.
  const [seeding, setSeeding] = useState(!!deepLinkId);
  const [deepLinkAttempt, setDeepLinkAttempt] = useState(0);
  // Set once any explicit selection re-roots the view, so a slower deep-link
  // lookup that resolves afterwards doesn't clobber the user's choice.
  const deepLinkSuperseded = useRef(false);

  async function runSearch(q: string) {
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setLoading(true);
    setFailure(null);
    try {
      setResults(
        await fetchJson<SearchResult>(
          `/api/search?q=${encodeURIComponent(q)}`,
          "検索に失敗しました",
          { signal: controller.signal },
        ),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setFailure({
        error: toError(err, "検索に失敗しました"),
        retry: () => void runSearch(q),
      });
      setResults(null);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) await runSearch(q);
  }

  // Stable identity so GraphPane's cytoscape effect doesn't rebuild on every
  // parent render (it lists these callbacks as dependencies).
  const selectPerson = useCallback((person: FocusPerson) => {
    deepLinkSuperseded.current = true;
    setFocus(person);
    setCurrent(person);
    setPathTarget(null);
    setResults(null);
    setMobilePane("graph");
  }, []);

  // The ego view reports its read target (last fired) here; it never re-anchors.
  const showCurrent = useCallback((person: FocusPerson) => {
    setCurrent(person);
  }, []);

  const choosePathTarget = useCallback((person: FocusPerson) => {
    setPathTarget(person);
    setResults(null);
    setMobilePane("graph");
  }, []);

  // Deep link: `?id=Qxxx` opens that person's ego graph directly. Resolve the id
  // to a full FocusPerson before seeding so the graph and article render with the
  // real label/title, no placeholder flash.
  useEffect(() => {
    if (!deepLinkId) return;
    let cancelled = false;
    (async () => {
      try {
        const person = await fetchJson<FocusPerson>(
          `/api/person/${encodeURIComponent(deepLinkId)}`,
          "人物の取得に失敗しました",
        );
        if (!cancelled && !deepLinkSuperseded.current) selectPerson(person);
      } catch (err) {
        if (!cancelled)
          setFailure({
            error:
              err instanceof ApiError && err.status === 404
                ? new Error(`人物が見つかりません (${deepLinkId})`)
                : toError(err, "人物の取得に失敗しました"),
            retry: () => {
              setFailure(null);
              setSeeding(true);
              setDeepLinkAttempt((n) => n + 1);
            },
          });
      } finally {
        if (!cancelled) setSeeding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkId, deepLinkAttempt, selectPerson]);

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
            // min-w-0 releases the input's size-based min-width floor (~216px);
            // without it the button absorbs the whole squeeze and 検索 wraps.
            className="border-rule-strong min-w-0 flex-1 rounded-md border bg-white/60 px-3 py-1.5"
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-ink text-washi shrink-0 rounded-md px-4 py-1.5 disabled:opacity-50"
          >
            検索
          </button>
        </form>
      </header>

      {loading && <p className="text-muted px-4 py-2 text-sm">検索中…</p>}
      {failure &&
        (isUnavailable(failure.error) ? (
          <div className="px-4 py-2">
            <ServiceNotice onRetry={failure.retry} />
          </div>
        ) : (
          <p className="text-vermilion px-4 py-2 text-sm">
            {failure.error.message}
          </p>
        ))}
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

      {focus && (
        <div className="border-rule flex border-b md:hidden">
          <PaneTab
            label="家系図"
            active={mobilePane === "graph"}
            controls="pane-graph"
            onSelect={() => setMobilePane("graph")}
          />
          <PaneTab
            label="記事"
            // Firing a node swaps the article behind the hidden pane — this label
            // is the only on-screen sign the read target changed.
            hint={(pathTarget ?? current ?? focus).label}
            active={mobilePane === "article"}
            controls="pane-article"
            onSelect={() => setMobilePane("article")}
          />
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        {focus ? (
          <>
            <section
              id="pane-graph"
              className={`border-rule w-full flex-col md:flex md:w-1/2 md:border-r ${
                mobilePane === "graph" ? "flex" : "hidden"
              }`}
            >
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
              {pathTarget ? (
                <GraphToggle
                  label="配偶者を含む"
                  checked={includeSpouses}
                  onChange={setIncludeSpouses}
                />
              ) : (
                <GraphToggle
                  label="養子・養父を表示"
                  checked={showAdoptions}
                  onChange={setShowAdoptions}
                />
              )}
              <div className="relative min-h-0 flex-1">
                {/* A spouse toggle must remount, not just refetch — otherwise the
                    stale path stays on screen until the new one lands. Keyed only in
                    path mode, so the ego view can never be torn down by it. */}
                <GraphPane
                  key={
                    pathTarget
                      ? `${focus.qid}:${pathTarget.qid}:${includeSpouses}`
                      : focus.qid
                  }
                  focus={focus}
                  pathTo={pathTarget}
                  showAdoptions={showAdoptions}
                  includeSpouses={includeSpouses}
                  onSelect={selectPerson}
                  onCurrent={showCurrent}
                />
              </div>
            </section>
            <section
              id="pane-article"
              className={`w-full overflow-auto md:block md:w-1/2 ${
                mobilePane === "article" ? "block" : "hidden"
              }`}
            >
              {/* Stateless iframe: changing the person prop navigates it in
                  place. */}
              <ArticlePane person={pathTarget ?? current ?? focus} />
            </section>
          </>
        ) : seeding ? (
          <p className="text-muted m-auto">読み込み中…</p>
        ) : (
          <p className="text-muted m-auto">
            人物を検索して選択すると家系グラフと記事を表示します
          </p>
        )}
      </main>
    </div>
  );
}
