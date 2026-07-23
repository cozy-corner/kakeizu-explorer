import type { GraphNode } from "@/lib/graph";

// Embeds the person's ja.wikipedia article inline. /wiki/{title} resolves
// redirects/normalization itself and renders Wikipedia's own "no article" page
// on a miss, so the `wikipediaTitle` (Wikidata sitelink) → `label` fallback
// needs no validation here.
export function ArticlePane({
  person,
}: {
  person: Pick<GraphNode, "label" | "wikipediaTitle">;
}) {
  const title = person.wikipediaTitle ?? person.label;
  return (
    <iframe
      title={`${title} の Wikipedia 記事`}
      src={`https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`}
      className="h-full w-full border-0"
    />
  );
}
