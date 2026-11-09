#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`truddy needs Node.js 18.17 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

import('../src/cli.js')
  .then(({ main }) => main(process.argv.slice(2)))
  .catch((err) => {
    process.stderr.write('\x1b[?25h');
    console.error('\n  truddy crashed:', err?.stack || err);
    console.error('  please report it: https://github.com/Radardotfun/truddy/issues\n');
    process.exit(1);
  });
