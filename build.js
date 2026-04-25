import esbuild from 'esbuild';

esbuild.buildSync({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.js',
  target: 'node18',
  sourcemap: true,
});

console.log('Build complete');
