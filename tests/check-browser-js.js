const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
if (!blocks.length) throw new Error('No inline script found in index.html');
new vm.Script(blocks.at(-1)[1], { filename: 'index.html:inline-script' });
console.log('Browser JavaScript syntax OK');
