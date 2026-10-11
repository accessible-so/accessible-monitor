import { ProductCard } from '../../components/ProductCard';

/** `/products/red-shoes` — the dynamic-segment case, `/products/[slug]`. */
export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <div>
      <h1>Product</h1>
      <ProductCard name={slug} />
    </div>
  );
}
