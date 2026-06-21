#!/usr/bin/env node
'use strict';

/**
 * Troubleshoot script for Sub Model Gateway
 *
 * Runs diagnostic checks to identify why the gateway isn't working.
 * Tests each layer independently: credentials, token, billing header,
 * sanitization, proxy health, end-to-end proxy routing, and client config.
 *
 * Usage:
 *   node troubleshoot.js [--profile runtime] [--config config.json]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('./src/config');
const { createReporter, checkSelectedProfileToken, apiTest, requestProxyHealth, requestProxyMessage } = require('./src/troubleshoot-helpers');

const homeDir = os.homedir();
const reporter = createReporter(console);
const { ok, fail, info, state } = reporter;

function parseJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

function nestedBaseUrl(config) {
  return config.models &&
    config.models.providers &&
    config.models.providers.anthropic &&
    config.models.providers.anthropic.baseUrl;
}

function directBaseUrl(config) {
  return config.baseUrl ||
    config.anthropicBaseUrl ||
    nestedBaseUrl(config);
}

function checkBaseUrl(runtimeName, configPaths, targetPort, exactDefaultPortMessage) {
  let found = false;
  for (const configPath of configPaths.filter(Boolean)) {
    if (!fs.existsSync(configPath)) continue;
    found = true;
    try {
      const runtimeConfig = parseJsonFile(configPath);
      const baseUrl = directBaseUrl(runtimeConfig);
      if (baseUrl) {
        if (baseUrl.includes('127.0.0.1:' + targetPort) || baseUrl.includes('localhost:' + targetPort)) {
          ok(runtimeName + ' baseUrl points to proxy', baseUrl);
        } else if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')) {
          info(runtimeName + ' baseUrl: ' + baseUrl + ' (custom local port -- make sure proxy is on that port)');
        } else {
          fail(runtimeName + ' baseUrl is NOT pointing to the proxy', baseUrl);
          info('Change the Anthropic-compatible baseUrl to "http://127.0.0.1:' + targetPort + '" in ' + configPath);
          info('Then restart the ' + runtimeName + ' gateway/runtime.');
          info('');
          if (exactDefaultPortMessage) info(exactDefaultPortMessage);
          info('If you intentionally use a separate provider for the proxy, this FAIL can be ignored.');
        }
      } else {
        fail('No baseUrl found in ' + runtimeName + ' config', runtimeName + ' may be using the default Anthropic API directly');
        info('Add or update the Anthropic-compatible provider baseUrl in ' + configPath + ':');
        info('  "baseUrl": "http://127.0.0.1:' + targetPort + '"');
        info('Then restart the ' + runtimeName + ' gateway/runtime.');
        info('If you intentionally use a separate provider for the proxy, this FAIL can be ignored.');
      }
    } catch (e) {
      info('Found ' + configPath + ' but failed to parse: ' + e.message);
    }
    break;
  }
  return found;
}

async function runTests() {
  let config;
  try {
    config = loadConfig({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), homeDir });
  } catch (e) {
    console.log('\n1. Loading gateway configuration...\n');
    fail('Config load failed', e.message);
    printSummary();
    process.exit(1);
  }

  const profileId = config.defaultProfile;
  const activeProfile = config.profiles[profileId];
  const sets = activeProfile.compatibilitySets || [];

  console.log('\n1. Checking Claude Code credentials...\n');
  const tokenCheck = checkSelectedProfileToken(config, { profileId, env: process.env, logger: console });
  if (!tokenCheck.ok) {
    fail('Selected profile credentials failed', tokenCheck.error);
    info('');
    info('Profile: ' + profileId);
    info('Credentials: ' + (activeProfile.credentialsPath || activeProfile.tokenEnv || 'none'));
    info('');
    info('To fix:');
    info('  npm install -g @anthropic-ai/claude-code');
    info('  claude auth login');
    info('  claude -p "test" --max-turns 1 --no-session-persistence   (forces credential write)');
    info('');
    info('Then run: node setup.js --profile ' + profileId + '   (auto-extracts Keychain tokens on Mac)');
    console.log('\nCannot continue without credentials. Fix this first.\n');
    printSummary();
    process.exit(1);
  }

  ok('Credentials found', 'profile=' + profileId + ', source=' + (activeProfile.credentialsPath || activeProfile.tokenEnv || 'env'));
  ok('Compatibility sets', sets.length ? sets.join(', ') : 'none');

  console.log('\n2. Checking token...\n');
  ok('Subscription', tokenCheck.detail.subscriptionType);
  if (tokenCheck.detail.expiresInHours > 0) {
    ok('Token expiry', tokenCheck.detail.expiresText);
  } else if (isFinite(tokenCheck.detail.expiresInHours)) {
    fail('Token EXPIRED', Math.abs(tokenCheck.detail.expiresInHours).toFixed(1) + ' hours ago');
    info('Run: claude auth login (to refresh)');
    info('Or open Claude Code CLI briefly -- it auto-refreshes');
  } else {
    ok('Token expiry', 'n/a');
  }

  const token = tokenCheck.token.accessToken;

  console.log('\n3. Testing API connectivity...\n');
  const raw = await apiTest(token, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Say OK' }]
  });

  if (raw.status === 401) {
    ok('API reachable', 'Got 401 (expected without billing header)');
  } else if (raw.status === 200) {
    ok('API reachable', 'Got 200 (token works without billing header on this model)');
  } else if (raw.status === 0) {
    fail('Cannot reach api.anthropic.com', raw.error);
    info('Check internet connection and DNS resolution');
  } else {
    info('API returned ' + raw.status + ' -- unexpected');
    try { info('Error: ' + JSON.parse(raw.body).error.message); } catch(e) {}
  }

  console.log('\n4. Testing billing header (Haiku)...\n');
  const billing = await apiTest(token, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;' },
      { type: 'text', text: 'Test.' }
    ],
    messages: [{ role: 'user', content: 'Say OK' }]
  });

  if (billing.status === 200) {
    if (billing.overage === 'rejected') {
      ok('Billing header works', 'Haiku 200, overage=rejected (subscription billing!)');
    } else {
      ok('Billing header works', 'Haiku 200, overage=' + billing.overage);
      if (billing.overage !== 'rejected') {
        info('overage status is not "rejected" -- may be billing to Extra Usage');
      }
    }
  } else {
    fail('Billing header rejected', 'Status ' + billing.status);
    try { info('Error: ' + JSON.parse(billing.body).error.message); } catch(e) {}
    info('Your Claude Code version may use a different billing header');
    info('Run the capture proxy to get YOUR billing header (see README)');
  }

  console.log('\n5. Testing billing header (Sonnet)...\n');
  const sonnet = await apiTest(token, {
    model: 'claude-sonnet-4-6',
    max_tokens: 8,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;' },
      { type: 'text', text: 'Test.' }
    ],
    messages: [{ role: 'user', content: 'Say OK' }]
  });

  if (sonnet.status === 200) {
    ok('Sonnet works', 'Status 200, overage=' + sonnet.overage);
  } else if (sonnet.status === 429) {
    info('Sonnet rate limited (429) -- try again in a few minutes');
    info('This is normal if you have active Claude Code sessions');
  } else {
    fail('Sonnet failed', 'Status ' + sonnet.status);
    try { info('Error: ' + JSON.parse(sonnet.body).error.message); } catch(e) {}
  }

  console.log('\n6. Testing trigger phrase detection...\n');
  const trigger = await apiTest(token, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;' },
      { type: 'text', text: 'You are a personal assistant running inside OpenClaw.' }
    ],
    messages: [{ role: 'user', content: 'Say OK' }]
  });

  if (trigger.status === 400) {
    ok('Trigger detection confirmed', '"running inside OpenClaw" correctly triggers rejection');
    info('This is expected -- the proxy sanitizes this phrase when the OpenClaw set is enabled');
  } else if (trigger.status === 200) {
    info('Trigger phrase was NOT detected (unexpected) -- detection may have changed');
  }

  console.log('\n7. Checking proxy...\n');
  const proxyCheck = await requestProxyHealth(config);
  if (proxyCheck.status === 200) {
    try {
      const health = JSON.parse(proxyCheck.body);
      const patternCount = health.replacementPatterns || (health.layers && health.layers.stringReplacements) || '?';
      ok('Proxy running', 'Port ' + config.port + ', ' + health.requestsServed + ' requests served, ' + patternCount + ' patterns');
      if (health.compatibilitySets) ok('Proxy compatibility sets', health.compatibilitySets.join(', ') || 'none');
      if (health.tokenExpiresInHours && parseFloat(health.tokenExpiresInHours) <= 0) {
        fail('Proxy token expired', 'Run: claude auth login');
      }
    } catch(e) {
      ok('Proxy running', 'Port ' + config.port);
    }
  } else {
    fail('Proxy not running on port ' + config.port, proxyCheck.error || 'Status ' + proxyCheck.status);
    info('Start it with: node proxy.js --profile ' + profileId);
  }

  if (proxyCheck.status === 200) {
    console.log('\n8. Testing end-to-end through proxy...\n');
    const e2e = await requestProxyMessage(config, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      system: 'You are a personal assistant running inside OpenClaw. Test with sessions_spawn and sessions_yield.',
      messages: [{ role: 'user', content: 'Say E2E_OK' }]
    });

    if (e2e.status === 200) {
      ok('End-to-end test PASSED', 'Request with trigger phrases went through proxy successfully');
    } else {
      fail('End-to-end test FAILED', 'Status ' + e2e.status);
      try {
        const err = JSON.parse(e2e.body);
        if (err.error) {
          info('Error: ' + err.error.message);
          if (err.error.message.includes('extra usage') || err.error.message.includes('Third-party')) {
            info('');
            info('The proxy is not fully sanitizing your request body.');
            info('Your runtime version may have additional trigger terms.');
            info('Enable the right compatibility set or add more patterns to config.json replacements array.');
            info('See README for troubleshooting guidance.');
          }
        }
      } catch(e) {
        info('Response: ' + (e2e.body || e2e.error || 'no response body').substring(0, 200));
      }
    }
  }

  console.log('\n9. Checking runtime client configuration...\n');
  if (sets.includes('openclaw')) {
    const foundOpenClaw = checkBaseUrl('OpenClaw', [
      path.join(homeDir, '.openclaw', 'openclaw.json'),
      path.join(homeDir, '.openclaw', 'config.json')
    ], config.port, 'Note: ANTHROPIC_BASE_URL env var does NOT control OpenClaw routing. You must set baseUrl in openclaw.json under models.providers.anthropic.');
    if (!foundOpenClaw) {
      info('OpenClaw config not found at ~/.openclaw/openclaw.json');
      info('(This check only works if OpenClaw is installed on this machine)');
    }
  }

  if (sets.includes('hermes-agent')) {
    const foundHermes = checkBaseUrl('Hermes Agent', [
      process.env.HERMES_AGENT_CONFIG,
      path.join(homeDir, '.hermes-agent', 'config.json'),
      path.join(homeDir, '.hermes-agent', 'hermes-agent.json'),
      path.join(homeDir, '.hermes', 'hermes-agent.json')
    ], config.port, null);
    if (!foundHermes) {
      info('Hermes Agent config not found in known paths');
      info('Set HERMES_AGENT_CONFIG to check a custom Hermes Agent config path.');
    }
  }

  if (!sets.includes('openclaw') && !sets.includes('hermes-agent')) {
    info('No built-in runtime client config check for active sets: ' + (sets.join(', ') || 'none'));
  }

  printSummary();
}

function printSummary() {
  console.log('\n---------------------------------');
  console.log('  Results: ' + state.passed + ' passed, ' + state.failed + ' failed');
  console.log('---------------------------------\n');

  if (state.failed === 0) {
    console.log('  Everything looks good! If runtime requests still fail,');
    console.log('  check the proxy console for 400 errors and add sanitization');
    console.log('  patterns to config.json for any trigger terms in your content.\n');
  } else {
    console.log('  Fix the FAIL items above and run this script again.\n');
  }
}

if (require.main === module) {
  runTests().catch((e) => {
    fail('Troubleshoot crashed', e.message);
    printSummary();
    process.exit(1);
  });
}

module.exports = {
  runTests,
  checkBaseUrl,
  directBaseUrl,
  nestedBaseUrl
};
