/**
 * Two builds of the same storefront page. B differs from A the way a routine
 * deploy does: CSS-module hashes rotate, utility arbitrary values change, list
 * siblings are reordered, and an unrelated wrapper appears. Two probes move to
 * a different landmark on purpose, so the stability metric is measured rather
 * than trivially 100%.
 */
export function buildCorpus(variant: 'A' | 'B'): string {
  const h = variant === 'A' ? 'a1b2c' : 'q9z8y';
  const gap = variant === 'A' ? 'gap-[12px]' : 'gap-[14px]';
  const cards = Array.from({ length: 8 }, (_, i) => i);
  const order = variant === 'A' ? cards : [...cards].reverse();
  const card = (i: number) => `
    <li class="ProductCard_root__${h} card ${gap}" data-a11y-component="ProductCard">
      <img data-probe="card-img-${i}" src="/p/${i}.png" class="ProductCard_img__${h}">
      <a data-probe="card-link-${i}" href="/products/${i}" class="ProductCard_link__${h}"><span>Product ${i}</span></a>
      <button data-probe="card-buy-${i}" class="btn btn-primary ProductCard_buy__${h}">Add</button>
      <div data-probe="card-price-${i}" class="ProductCard_price__${h}" aria-label="Price ${i * 3} dollars">$${i * 3}</div>
    </li>`;
  const wrapperOpen = variant === 'B' ? '<div class="Layout_grid__zz1x9">' : '';
  const wrapperClose = variant === 'B' ? '</div>' : '';
  // Probes "moved-1" and "moved-2" live in <main> in A and in <aside> in B.
  const moved = `
    <p><a data-probe="moved-1" href="/help">Help</a></p>
    <p><button data-probe="moved-2" class="btn">Chat</button></p>`;
  return `
    <header><nav aria-label="Primary">
      <ul><li><a data-probe="nav-home" href="/">Home</a></li><li><a data-probe="nav-shop" href="/shop">Shop</a></li></ul>
    </nav></header>
    <main>
      <h1 data-probe="h1" class="Title_h1__${h}">Shop</h1>
      <form aria-label="Search products" class="Search_form__${h}">
        <input data-probe="search-input" type="search" placeholder="Search" class="Search_input__${h}">
        <button data-probe="search-btn" type="submit" class="Search_btn__${h}">Go</button>
      </form>
      ${wrapperOpen}<ul class="Grid_list__${h}">${order.map(card).join('')}</ul>${wrapperClose}
      ${variant === 'A' ? moved : ''}
    </main>
    <aside aria-label="Support">${variant === 'B' ? moved : ''}</aside>
    <footer><a data-probe="footer-privacy" href="/privacy">Privacy</a></footer>`;
}
