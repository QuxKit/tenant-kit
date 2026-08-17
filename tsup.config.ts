// Build config. The root, the `./pg` adapter and the three framework helpers
// — ESM + CJS + declarations for each. The framework entries import no
// framework (they are typed against local interfaces), so nothing new is
// external.
//
// tsup (esbuild) rather than `tsc` for the same structural reason as
// billing-kit: `moduleResolution: bundler` lets src/ import extensionless
// while `tsc` would copy those specifiers through verbatim into ESM that
// Node's resolver rejects. esbuild resolves and rewrites them.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    pg: 'src/pg.ts',
    express: 'src/express.ts',
    hono: 'src/hono.ts',
    next: 'src/next.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  skipNodeModulesBundle: true,

  // `pg` is an optional peer: the adapter imports it, the build must not
  // inline it, and the root entry never touches it.
  external: ['pg'],

  // Matches tsconfig's `target`; esbuild does not read it from there.
  target: 'es2022',
  platform: 'node',

  // The `node:` prefix is what guarantees a builtin import cannot be shadowed
  // by a userland package of the same name. The source writes it; the build
  // has no business removing it.
  removeNodeProtocol: false,

  // `type: module` makes bare `.js` mean ESM, so CJS must be `.cjs` to load at
  // all. Naming both explicitly means `exports` never depends on `type`.
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
});
