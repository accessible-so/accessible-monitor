/**
 * One known barrier, on purpose: the `<img>` carries no `alt`, so axe's
 * `image-alt` rule reports `wcag:1.1.1` against it. The SWC plugin stamps the
 * outermost host element this component returns — the `<article>` — so the
 * finding on the image inside it is attributed to `ProductCard` and to this
 * file and line.
 */
export function ProductCard({ name }: { name: string }) {
  return (
    <article>
      <h2>{name}</h2>
      <img src="/x.png" width={80} height={80} />
      <p>A product nobody can hear described.</p>
    </article>
  );
}
