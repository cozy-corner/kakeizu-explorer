import type { GraphNode } from "@/lib/graph";

// Embed the live ja.wikipedia article so it reads directly in the pane, with no
// click-through to a separate tab. The article title is the Wikidata sitelink
// (`wikipediaTitle`, the canonical page title), falling back to the person's
// `label` when Wikidata records no ja.wikipedia article for them — /wiki/{title}
// resolves redirects/normalization itself and renders Wikipedia's own "no
// article" page on a miss.
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
