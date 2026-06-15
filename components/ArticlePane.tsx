"use client";

import { useEffect, useState } from "react";

// Only the fields we render from the ja.wikipedia REST summary. `type` is
// "standard" for a real article; disambiguation/redirect stubs use other values.
type Summary = {
  type: string;
  title: string;
  description?: string;
  extract: string;
  thumbnail?: { source: string };
  content_urls: { desktop: { page: string } };
};

type State = "loading" | "ok" | "missing" | "error";

// Uses the Wikidata label as the article title (real wikipediaTitle lands in
// PR6); a mismatch 404s (or resolves to a disambiguation stub) into the
// "missing" state. Mounted with key={focus.qid} so a focus change remounts and
// resets state to "loading".
export function ArticlePane({ title }: { title: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (res.status === 404) return setState("missing");
        if (!res.ok) return setState("error");
        const data = (await res.json()) as Summary;
        // A disambiguation page (or other non-article stub) comes back 200 with
        // boilerplate text; treat it as "no article" rather than the person's bio.
        if (data.type !== "standard") return setState("missing");
        setSummary(data);
        setState("ok");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState("error");
      });
    return () => controller.abort();
  }, [title]);

  if (state === "loading") {
    return <p className="p-4 text-sm text-zinc-500">記事を読み込み中…</p>;
  }
  if (state === "missing") {
    return (
      <p className="p-4 text-sm text-zinc-500">
        「{title}」の Wikipedia 記事はありません。
      </p>
    );
  }
  if (state === "error" || !summary) {
    return (
      <p className="p-4 text-sm text-red-600">記事の取得に失敗しました。</p>
    );
  }

  return (
    <article className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        {summary.thumbnail && (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary upload.wikimedia.org host; not worth configuring next/image remote patterns for a thumbnail.
          <img
            src={summary.thumbnail.source}
            alt={summary.title}
            className="max-h-32 w-auto rounded"
          />
        )}
        <div>
          <h2 className="text-xl font-semibold">{summary.title}</h2>
          {summary.description && (
            <p className="text-sm text-zinc-500">{summary.description}</p>
          )}
        </div>
      </div>
      <p className="leading-relaxed">{summary.extract}</p>
      <a
        href={summary.content_urls.desktop.page}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-blue-600 underline"
      >
        Wikipedia で全文を読む →
      </a>
    </article>
  );
}
