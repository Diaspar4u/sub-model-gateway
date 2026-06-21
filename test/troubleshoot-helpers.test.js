'use strict';

const assert = require('assert');
const test = require('node:test');
const { directBaseUrl, nestedBaseUrl } = require('../troubleshoot');

test('runtime baseUrl helpers support nested provider and direct runtime config shapes', () => {
  assert.strictEqual(nestedBaseUrl({
    models: {
      providers: {
        anthropic: {
          baseUrl: 'http://127.0.0.1:18801'
        }
      }
    }
  }), 'http://127.0.0.1:18801');

  assert.strictEqual(directBaseUrl({
    baseUrl: 'http://127.0.0.1:18801'
  }), 'http://127.0.0.1:18801');

  assert.strictEqual(directBaseUrl({
    anthropicBaseUrl: 'http://127.0.0.1:18802'
  }), 'http://127.0.0.1:18802');
});
