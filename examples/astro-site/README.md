# Astro fixture

The site `packages/monitor-astro`'s browser suite builds and drives: a static
page, a dynamic segment (`/products/[slug]`), a static route that must win over
it (`/products/featured`), a catch-all (`/docs/[...parts]`), and Astro's
client router for in-page navigation.

    pnpm --filter @accessible-so/monitor-astro build
    A11Y_ENDPOINT=http://localhost:4173 pnpm build && pnpm preview
