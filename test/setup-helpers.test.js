'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  buildSetupConfig,
  parseCredentialPayload,
  parseKeychainPayload
} = require('../src/setup-helpers');

test('buildSetupConfig writes profile-shaped config with selected sets', () => {
  const config = buildSetupConfig({
    profile: 'hermes',
    credentialsPath: '/tmp/hermes.credentials.json',
    compatibilitySets: ['hermes']
  });

  assert.strictEqual(config.profile, 'hermes');
  assert.strictEqual(config.credentialsPath, '/tmp/hermes.credentials.json');
  assert.deepStrictEqual(config.compatibilitySets, ['hermes']);
  assert.deepStrictEqual(Object.keys(config.profiles), ['hermes']);
  assert.strictEqual(config.routing.type, 'profile');
});

test('credential payload parser accepts claudeAiOauth and rejects unrelated JSON', () => {
  const valid = parseCredentialPayload(JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-test',
      expiresAt: Date.now() + 1000
    }
  }));
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.oauth.accessToken, 'sk-ant-test');

  const invalid = parseCredentialPayload(JSON.stringify({ mcpOAuth: {} }));
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.reason, 'missing-claude-ai-oauth');
  assert.deepStrictEqual(invalid.keys, ['mcpOAuth']);
});

test('keychain parser wraps raw Anthropic tokens', () => {
  const parsed = parseKeychainPayload('sk-ant-raw');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.rawToken, true);
  assert.strictEqual(parsed.oauth.accessToken, 'sk-ant-raw');
});
