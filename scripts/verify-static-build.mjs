import { readFileSync, existsSync, statSync } from 'node:fs';

const rootBundle = 'index.html';
const staticBundle = 'public/index.html';
if (!existsSync(staticBundle)) {
  throw new Error('Static build output missing: public/index.html');
}
if (statSync(staticBundle).size < 100_000) {
  throw new Error('Static build output is unexpectedly small; expected standalone APEX HTML.');
}

const rootHtml = readFileSync(rootBundle, 'utf8');
const staticHtml = readFileSync(staticBundle, 'utf8');
if (rootHtml !== staticHtml) {
  throw new Error('public/index.html does not match the generated standalone index.html.');
}
for (const marker of [
  'apex-backend-api-base-v1',
  'Test and connect',
  'window.APEXBackend',
  '/v1/health/live',
  '/v1/spot/trades'
]) {
  if (!staticHtml.includes(marker)) {
    throw new Error('Standalone bundle is missing Backend Spot integration marker: ' + marker);
  }
}
if (/\bsrc=["']\/src\//i.test(staticHtml)) {
  throw new Error('Standalone bundle still references local JavaScript files under /src/.');
}
console.log('Static Site verification passed: public/index.html is self-contained and includes Backend Spot API configuration.');
