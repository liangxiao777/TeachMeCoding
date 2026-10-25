const mode = process.argv[2];
if (mode !== 'development' && mode !== 'production') throw new Error('Choose development or production mode.');
process.env.NODE_ENV = mode;
await import(new URL(`../apps/server/${mode === 'development' ? 'src' : 'dist'}/index.js`, import.meta.url));
