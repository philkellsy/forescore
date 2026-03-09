'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ejs = require('ejs');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'test', 'migrations', 'scripts'];
const JS_EXT = '.js';
const EJS_EXT = '.ejs';

function walkFiles(dirPath, output = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, output);
      continue;
    }
    output.push(fullPath);
  }
  return output;
}

function lintJsFiles(jsFiles) {
  const errors = [];
  for (const filePath of jsFiles) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      const details = (result.stderr || result.stdout || '').trim();
      errors.push(`JS syntax error in ${filePath}\n${details}`);
    }
  }
  return errors;
}

function lintEjsFiles(ejsFiles) {
  const errors = [];
  for (const filePath of ejsFiles) {
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      ejs.compile(source, { filename: filePath });
    } catch (error) {
      errors.push(`EJS compile error in ${filePath}\n${error.message}`);
    }
  }
  return errors;
}

function main() {
  const allFiles = [];
  for (const relDir of SCAN_DIRS) {
    const absDir = path.join(ROOT, relDir);
    if (fs.existsSync(absDir)) {
      walkFiles(absDir, allFiles);
    }
  }

  const jsFiles = allFiles.filter((filePath) => filePath.endsWith(JS_EXT));
  const ejsFiles = allFiles.filter((filePath) => filePath.endsWith(EJS_EXT));

  const jsErrors = lintJsFiles(jsFiles);
  const ejsErrors = lintEjsFiles(ejsFiles);
  const errors = [...jsErrors, ...ejsErrors];

  if (errors.length) {
    console.error(`\nLint failed with ${errors.length} error(s):\n`);
    for (const err of errors) {
      console.error(`${err}\n`);
    }
    process.exit(1);
  }

  console.log(`Lint OK (${jsFiles.length} JS, ${ejsFiles.length} EJS)`);
}

main();

