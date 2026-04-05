// @ts-check
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProd  = process.env.NODE_ENV === 'production';

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle:    true,
  target:    'chrome120',
  sourcemap: !isProd,
  minify:    isProd,
  logLevel:  'info',
};

const entries = [
  // Service worker — ESM is allowed in MV3 SW when manifest sets "type":"module"
  {
    ...shared,
    entryPoints: ['src/background/service-worker.ts'],
    outfile:     'dist/service-worker.js',
    format:      'esm',
    platform:    'browser',
  },
  // Content script — must be IIFE (no ESM in content scripts)
  {
    ...shared,
    entryPoints: ['src/content/index.ts'],
    outfile:     'dist/content.js',
    format:      'iife',
    platform:    'browser',
  },
  // Page-world bridge injected via scripting.executeScript
  {
    ...shared,
    entryPoints: ['src/page-script/bridge.ts'],
    outfile:     'dist/page-bridge.js',
    format:      'iife',
    platform:    'browser',
  },
];

if (isWatch) {
  const ctxs = await Promise.all(entries.map(e => esbuild.context(e)));
  await Promise.all(ctxs.map(c => c.watch()));
  console.log('[Lanthra] Watching for changes...');
} else {
  await Promise.all(entries.map(e => esbuild.build(e)));
}
