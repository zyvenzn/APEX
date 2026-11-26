// Inline src/style.css and src/app.js into index.html:  node build.js
const fs = require('fs'), path = require('path');
const p = f => path.join(__dirname, f);
const read = f => fs.readFileSync(p(f), 'utf8');
let html = read('index.html');
const swap = (re, body, name) => {
  if (!re.test(html)) throw new Error(name + ' block not found in index.html');
  html = html.replace(re, (m, open, old, close) => open + body + close);
};
swap(/(<style>)([\s\S]*?)(<\/style>)/, read('src/style.css'), 'style');
swap(/(<script>)(\(\(\)=>\{[\s\S]*?)(<\/script>)/, read('src/app.js'), 'app script');
fs.writeFileSync(p('index.html'), html);
console.log('index.html updated');
