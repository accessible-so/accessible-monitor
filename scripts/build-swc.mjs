#!/usr/bin/env node
// Builds the SWC attribution plugin to wasm and drops it where the
// `@accessible-so/monitor-next` package expects to find it.
//
// The wasm is a build artefact, not a source file: it is gitignored and
// produced here, by CI, and by `pnpm --filter @accessible-so/monitor-next
// build:swc`. Everything in the adapter works without it — attribution is
// simply null — so this is deliberately a separate script rather than part of
// the package's `build`, which must stay runnable on a machine with no Rust
// toolchain.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'crates', 'swc-plugin-accessible', 'Cargo.toml');
const target = 'wasm32-wasip1';
const built = join(
  root,
  'crates',
  'swc-plugin-accessible',
  'target',
  target,
  'release',
  'swc_plugin_accessible.wasm',
);
const dest = join(root, 'packages', 'monitor-next', 'swc', 'plugin.wasm');

const build = spawnSync(
  'cargo',
  ['build', '--release', '--target', target, '--manifest-path', manifest],
  {
    stdio: 'inherit',
    // Panic locations embed absolute source paths; strip the builder's home
    // directory so a published wasm does not carry it.
    env: {
      ...process.env,
      RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${homedir()}=~`]
        .filter(Boolean)
        .join(' '),
    },
  },
);

if (build.error?.code === 'ENOENT') {
  console.error(
    'cargo not found. Install Rust (https://rustup.rs) and the wasm target:\n' +
      `  rustup target add ${target}`,
  );
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(built, dest);

const bytes = statSync(dest).size;
console.log(
  `plugin.wasm  ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(0)} KB)  ->  ${dest}`,
);
