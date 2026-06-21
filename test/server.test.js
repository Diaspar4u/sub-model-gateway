'use strict';

const assert = require('assert');
const http = require('http');
const test = require('node:test');
const { loadConfig } = require('../src/config');
const { createGatewayServer } = require('../src/server');
const { TokenStore } = require('../src/token-store');

const logger = {
  log() {},
  warn() {},
  error() {}
};

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function requestJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString()
      }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('gateway forwards through selected profile and reverse-maps error responses', async () => {
  const captured = {};
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      captured.headers = req.headers;
      captured.body = Buffer.concat(chunks).toString();
      res.writeHead(400, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          message: 'OCPlatform request failed',
          tool: {
            name: 'mcp_Bash',
            input: {
              thread_id: 'thread-1'
            }
          }
        }
      }));
    });
  });

  const upstreamPort = await listen(upstream);
  const config = loadConfig({
    cwd: process.cwd(),
    env: { OAUTH_TOKEN: 'sk-profile-token' }
  });
  config.upstream = {
    protocol: 'http:',
    host: '127.0.0.1',
    port: upstreamPort
  };

  const tokenStore = new TokenStore({
    profiles: config.profiles,
    env: { OAUTH_TOKEN: 'sk-profile-token' },
    logger
  });
  const gateway = createGatewayServer(config, { tokenStore, logger });
  const gatewayPort = await listen(gateway);

  try {
    const response = await requestJson(gatewayPort, '/v1/messages', {
      model: 'claude-sonnet-4-6',
      tools: [{ name: 'exec', description: 'Run OpenClaw command' }],
      messages: [{ role: 'user', content: 'OpenClaw run exec' }]
    }, {
      authorization: 'Bearer local-token',
      'x-api-key': 'local-key',
      'x-sub-model-profile': 'default'
    });

    assert.strictEqual(response.statusCode, 400);
    const parsedBody = JSON.parse(response.body);
    assert.strictEqual(parsedBody.error.message, 'OpenClaw request failed');
    assert.strictEqual(parsedBody.error.tool.name, 'exec');
    assert.strictEqual(parsedBody.error.tool.input.session_id, 'thread-1');
    assert.strictEqual(response.headers['transfer-encoding'], undefined);
    assert.strictEqual(response.headers['content-length'], String(Buffer.byteLength(response.body)));
    assert.strictEqual(captured.headers.authorization, 'Bearer sk-profile-token');
    assert.strictEqual(captured.headers['x-api-key'], undefined);
    assert.strictEqual(captured.headers['x-sub-model-profile'], undefined);
    assert.ok(captured.body.includes('"name":"mcp_Bash"'));
    assert.ok(captured.body.includes('OCPlatform run exec'));
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
