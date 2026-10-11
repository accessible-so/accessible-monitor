import Link from 'next/link';

/** The landing page. Deliberately clean: the sampling scenario asserts silence. */
export default function HomePage() {
  return (
    <div>
      <h1>Accessible Next example</h1>
      <ul>
        <li>
          <Link id="to-blue" href="/products/blue-shoes">
            Blue shoes
          </Link>
        </li>
        <li>
          <Link id="to-docs" href="/docs/a/b">
            Docs
          </Link>
        </li>
      </ul>
    </div>
  );
}
