#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = path.join(__dirname, 'test');
const files = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name));

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
