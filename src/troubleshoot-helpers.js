'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { TokenStore } = require('./token-store');
const { getRuntimeBaseUrl } = require('./setup-helpers');

function createReporter(output = console) {
  const state = { passed: 0, failed: 0 };
  return {
    state,
    ok(name, detail) {
      state.passed++;
      output.log('  [PASS] ' + name + (detail ? ' -- ' + detail : ''));
    },
    fail(name, detail) {
      state.failed++;
      output.log('  [FAIL] ' + name + (detail ? ' -- ' + detail : ''));
    },
    info(msg) {
      output.log('  [INFO] ' + msg);
    }
  };
}

function describeToken(token) {
  const expiresIn = (token.expiresAt - Date.now()) / 3600000;
  return {
    subscriptionType: token.subscriptionType || 'unknown',
    expiresInHours: expiresIn,
    expiresText: isFinite(expiresIn) ? expiresIn.toFixed(1) + ' hours remaining' : 'n/a'
  };
}

function checkSelectedProfileToken(config, options = {}) {
  const tokenStore = options.tokenStore || new TokenStore({
    profiles: config.profiles,
    env: options.env || process.env,
    logger: options.logger || console
  });
  const profileId = options.profileId || config.defaultProfile;
  try {
    const token = tokenStore.getTokenSync(profileId);
    const detail = describeToken(token);
    return {
      ok: true,
      profileId,
      token,
      detail
    };
  } catch (e) {
    return {
      ok: false,
      profileId,
      error: e.message
    };
  }
}

function apiTest(token, body, headers, options = {}) {
  const httpsImpl = options.https || https;
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const h = Object.assign({
      'content-type': 'application/json',
      'authorization': 'Bearer ' + token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24',
      'content-length': Buffer.byteLength(bodyStr),
      'accept-encoding': 'identity'
    }, headers || {});

    const req = httpsImpl.request({
      hostname: 'api.anthropic.com', port: 443,
      path: '/v1/messages', method: 'POST', headers: h
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        const overage = res.headers['anthropic-ratelimit-unified-overage-status'] || 'missing';
        resolve({ status: res.statusCode, overage, body: data });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

function requestProxyHealth(config, options = {}) {
  const httpImpl = options.http || http;
  const host = options.host || '127.0.0.1';
  const port = options.port || config.port;
  return new Promise((resolve) => {
    const req = httpImpl.request({
      hostname: host,
      port,
      path: '/health',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

function requestProxyMessage(config, body, options = {}) {
  const httpImpl = options.http || http;
  const host = options.host || '127.0.0.1';
  const port = options.port || config.port;
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const req = httpImpl.request({
      hostname: host,
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'authorization': 'Bearer dummy-proxy-will-replace',
        'content-length': Buffer.byteLength(bodyStr)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

function findOpenClawBaseUrl(options = {}) {
  const fsImpl = options.fs || fs;
  const homeDir = options.homeDir || os.homedir();
  const paths = options.paths || [
    path.join(homeDir, '.openclaw', 'openclaw.json'),
    path.join(homeDir, '.openclaw', 'config.json')
  ];

  for (const ocPath of paths) {
    if (!fsImpl.existsSync(ocPath)) continue;
    const ocRaw = fsImpl.readFileSync(ocPath, 'utf8');
    const ocConfig = JSON.parse(ocRaw.charCodeAt(0) === 0xFEFF ? ocRaw.slice(1) : ocRaw);
    return {
      found: true,
      path: ocPath,
      baseUrl: getRuntimeBaseUrl(ocConfig)
    };
  }

  return { found: false };
}

module.exports = {
  createReporter,
  describeToken,
  checkSelectedProfileToken,
  apiTest,
  requestProxyHealth,
  requestProxyMessage,
  findOpenClawBaseUrl
};
