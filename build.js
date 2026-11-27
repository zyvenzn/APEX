// Build a self-contained static bundle from the maintained source files.
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const scriptAssets = [
  '/src/market-data/chain-registry.js',
  '/src/market-engine.js',
  '/src/bonding-curve.js',
  '/src/spot-trading-router.js',
  '/src/market-chart.js',
  '/src/app.js',
  '/src/backend-integration.js'
];

let html = read('index.html');
const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/g) || [];
if (styleBlocks.length !== 1) {
  throw new Error('Expected exactly one style block in index.html; found ' + styleBlocks.length);
}
html = html.replace(styleBlocks[0], '<style>\n' + read('src/style.css') + '\n</style>');

for (const asset of scriptAssets) {
  let matches = 0;
  const scriptPattern = /<script\b([^>]*)data-apex-build="([^"]+)"([^>]*)>[\s\S]*?<\/script>/g;
  html = html.replace(scriptPattern, (tag, before, src, after) => {
    if (src !== asset) return tag;
    matches++;
    return '<script data-apex-build="' + asset + '">\n' + read(asset.slice(1)) + '\n</script>';
  });
  if (matches !== 1) {
    throw new Error('Expected exactly one build marker for ' + asset + '; found ' + matches);
  }
}

if (html.includes('src="/src/')) {
  throw new Error('Unbundled local script reference remains in index.html');
}

fs.writeFileSync(path.join(root, 'index.html'), html);
const outputDir = path.join(root, 'public');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'index.html'), html);
console.log('Built index.html and public/index.html with ' + scriptAssets.length + ' JavaScript assets and src/style.css');
