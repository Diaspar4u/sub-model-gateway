'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { TokenStore } = require('../src/token-store');

const logger = {
  log() {},
  warn() {},
  error() {}
};

function tempCredentials(oauth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smg-token-'));
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }, null, 2));
  return { dir, file };
}

test('TokenStore reads env-token profiles without file I/O', async () => {
  const store = new TokenStore({
    profiles: {
      default: { id: 'default', tokenEnv: 'OAUTH_TOKEN' }
    },
    env: { OAUTH_TOKEN: 'sk-env' },
    logger
  });

  const token = await store.getToken('default');
  assert.strictEqual(token.accessToken, 'sk-env');
  assert.strictEqual(token.expiresAt, Infinity);
  assert.strictEqual(token.subscriptionType, 'env-var');
});

test('TokenStore keeps separate profile caches and refresh promises', async () => {
  const now = Date.now();
  const a = tempCredentials({
    accessToken: 'old-a',
    refreshToken: 'refresh-a',
    expiresAt: now - 1000,
    subscriptionType: 'max'
  });
  const b = tempCredentials({
    accessToken: 'old-b',
    refreshToken: 'refresh-b',
    expiresAt: now + 3600000,
    subscriptionType: 'pro'
  });

  const refreshCalls = [];
  const store = new TokenStore({
    profiles: {
      a: { id: 'a', credentialsPath: a.file },
      b: { id: 'b', credentialsPath: b.file }
    },
    fetchImpl: async (_url, options) => {
      refreshCalls.push(String(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: 'new-a',
            refresh_token: 'new-refresh-a',
            expires_in: 3600
          };
        }
      };
    },
    logger
  });

  const [token1, token2] = await Promise.all([
    store.getToken('a'),
    store.getToken('a')
  ]);
  const tokenB = await store.getToken('b');

  assert.strictEqual(token1.accessToken, 'new-a');
  assert.strictEqual(token2.accessToken, 'new-a');
  assert.strictEqual(tokenB.accessToken, 'old-b');
  assert.strictEqual(refreshCalls.length, 1);
  assert.ok(refreshCalls[0].includes('refresh_token=refresh-a'));

  const persisted = JSON.parse(fs.readFileSync(a.file, 'utf8')).claudeAiOauth;
  assert.strictEqual(persisted.accessToken, 'new-a');
  assert.strictEqual(persisted.refreshToken, 'new-refresh-a');
  const unchanged = JSON.parse(fs.readFileSync(b.file, 'utf8')).claudeAiOauth;
  assert.strictEqual(unchanged.accessToken, 'old-b');
});
