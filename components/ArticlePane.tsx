// Embed the live ja.wikipedia article so it reads directly in the pane, with no
// click-through to a separate tab. `title` is the person's Wikidata label;
// /wiki/{title} resolves redirects/normalization itself and renders Wikipedia's
// own "no article" page on a miss (acceptable for MVP).
// TODO: use the wikipediaTitle property as the title once ETL populates it.
export function ArticlePane({ title }: { title: string }) {
  return (
    <iframe
      title={`${title} の Wikipedia 記事`}
      src={`https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`}
      className="h-full w-full border-0"
    />
  );
}
