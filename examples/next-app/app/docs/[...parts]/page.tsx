/**
 * `/docs/a/b` — the catch-all case, `/docs/[...parts]`. Its own missing-alt
 * image, rather than a `ProductCard`, so the finding here is attributed to
 * this page and never borrows the other route's component.
 */
export default async function DocsPage({ params }: { params: Promise<{ parts: string[] }> }) {
  const { parts } = await params;
  return (
    <div>
      <h1>Docs</h1>
      <p>{parts.join(' / ')}</p>
      <img src="/x.png" width={80} height={80} />
    </div>
  );
}
