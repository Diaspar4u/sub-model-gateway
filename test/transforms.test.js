'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  computeBillingFingerprint,
  computeCch,
  createSseStreamTransformer,
  extractFirstUserText,
  getModelBetas,
  maskOpaquePayloads,
  processBody,
  repairToolPairs,
  reverseMap,
  stripEffortFromObject,
  transformErrorBody,
  transformJsonResponseBody,
  unmaskOpaquePayloads
} = require('../src/transforms');

const logger = {
  log() {},
  warn() {},
  error() {}
};

function fixtureJson(name) {
  return JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')));
}

test('billing helpers preserve expected shapes', () => {
  assert.strictEqual(computeCch('hello world'), 'b94d2');
  assert.match(computeBillingFingerprint('hello world'), /^[0-9a-f]{3}$/);
  assert.deepStrictEqual(getModelBetas('claude-haiku-4-5'), [
    'oauth-2025-04-20',
    'claude-code-20250219',
    'prompt-caching-scope-2026-01-05',
    'context-management-2025-06-27'
  ]);
  assert.ok(getModelBetas('claude-sonnet-4-6').includes('effort-2025-11-24'));
});

test('extractFirstUserText supports string and array content', () => {
  assert.strictEqual(
    extractFirstUserText(JSON.stringify({ messages: [{ role: 'user', content: 'hello\nworld' }] })),
    'hello\nworld'
  );
  assert.strictEqual(
    extractFirstUserText(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'array text' }] }] })),
    'array text'
  );
  assert.strictEqual(extractFirstUserText(JSON.stringify({ messages: [] })), '');
});

test('repairToolPairs removes orphaned tool blocks without breaking turn order', () => {
  const body = JSON.stringify({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'exec', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] }
    ]
  });
  const repaired = repairToolPairs(body, logger);
  const messages = JSON.parse(repaired).messages;
  assert.deepStrictEqual(messages[1].content, [{ type: 'text', text: '(removed)' }]);
});

test('processBody applies request transforms while preserving opaque regions', () => {
  const body = fixtureJson('request-openclaw.json');
  const result = processBody(body, {
    stripSystemConfig: false,
    stripToolDescriptions: true
  }, {
    identity: { deviceId: 'device-1', sessionId: 'session-1' },
    logger
  });

  assert.ok(result.includes('x-anthropic-billing-header: cc_version='));
  assert.ok(result.includes('"metadata":{"user_id":"{\\"device_id\\":\\"device-1\\",\\"session_id\\":\\"session-1\\"}"'));
  assert.ok(result.includes('"name":"mcp_Bash"'));
  assert.ok(result.includes('"thread_id":"s1"'));
  assert.ok(!result.includes('Run shell commands for OpenClaw'));
  assert.ok(result.includes('"description":""'));
  assert.ok(result.includes('"type":"image"'));
  assert.ok(result.includes('Do not mutate OpenClaw'));
  assert.ok(!result.includes('Do not mutate OCPlatform'));
  assert.ok(result.includes('inside redacted thinking'));
  assert.ok(!result.includes('inside redacted OCPlatform'));
  assert.ok(result.includes('OpenClawOpenClawOpenClawOpenClaw'));
});

test('processBody injects system array for string or missing system', () => {
  const withStringSystem = processBody(JSON.stringify({
    model: 'claude-sonnet-4-6',
    system: 'plain system',
    messages: [{ role: 'user', content: 'hello' }]
  }), {}, {
    identity: { deviceId: 'd', sessionId: 's' },
    logger
  });
  assert.ok(withStringSystem.includes('"system":[{"type":"text","text":"x-anthropic-billing-header:'));
  assert.ok(withStringSystem.includes('{"type":"text","text":"plain system"}'));

  const withoutSystem = processBody(JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }]
  }), {}, {
    identity: { deviceId: 'd', sessionId: 's' },
    logger
  });
  assert.ok(withoutSystem.startsWith('{"metadata"'));
  assert.ok(withoutSystem.includes('"system":[{"type":"text","text":"x-anthropic-billing-header:'));
});

test('Haiku effort stripping handles output_config and thinking objects', () => {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    output_config: { effort: 'high', keep: true },
    thinking: { effort: 'low' },
    messages: [{ role: 'user', content: 'hello' }]
  });
  const result = processBody(body, {}, {
    identity: { deviceId: 'd', sessionId: 's' },
    logger
  });
  assert.ok(result.includes('"output_config":{"keep":true}'));
  assert.ok(!result.includes('"thinking"'));
  assert.ok(!result.includes('"effort"'));
});

test('maskOpaquePayloads round-trips base64-like payloads', () => {
  const rawValue = 'OpenClaw'.repeat(32);
  const body = JSON.stringify({
    source: { type: 'base64', media_type: 'image/png', data: rawValue },
    text: 'OpenClaw'
  });
  const { masked, masks } = maskOpaquePayloads(body);
  assert.ok(!masked.includes(rawValue));
  assert.strictEqual(unmaskOpaquePayloads(masked, masks), body);
});

test('reverseMap handles plain and escaped names/properties', () => {
  const input = JSON.stringify({
    name: 'mcp_Bash',
    input: {
      thread_id: '1',
      partial_json: '{"mcp_SendMessage":true,"thread_id":"2"}'
    },
    text: 'OCPlatform'
  });
  const result = reverseMap(input, {});
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.name, 'exec');
  assert.strictEqual(parsed.input.session_id, '1');
  assert.ok(parsed.input.partial_json.includes('"message"'));
  assert.ok(parsed.input.partial_json.includes('"session_id"'));
  assert.strictEqual(parsed.text, 'OpenClaw');
});

test('JSON response reverse mapping preserves thinking blocks byte-identically', () => {
  const body = JSON.stringify({
    content: [
      { type: 'thinking', thinking: 'OCPlatform should stay mcp_Bash' },
      { type: 'redacted_thinking', data: 'OCPlatform should also stay mcp_Bash' },
      { type: 'text', text: 'OCPlatform should become "mcp_Bash"' }
    ]
  });
  const result = transformJsonResponseBody(body, {});
  assert.ok(result.includes('OCPlatform should stay mcp_Bash'));
  assert.ok(result.includes('OCPlatform should also stay mcp_Bash'));
  assert.ok(result.includes('OpenClaw should become \\"exec\\"'));
});

test('SSE stream transform buffers chunks, preserves UTF-8, and tracks thinking state', () => {
  const transformer = createSseStreamTransformer({});
  const stream = [
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OCPlatform uses mcp_Bash 中文"}}\n\n',
    'data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":"OCPlatform mcp_Bash"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"OCPlatform mcp_Bash"}}\n\n',
    'data: {"type":"content_block_stop"}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OCPlatform again"}}'
  ].join('');
  const bytes = Buffer.from(stream);
  const outputs = [
    transformer.push(bytes.slice(0, 17)),
    transformer.push(bytes.slice(17, 113)),
    transformer.push(bytes.slice(113)),
    transformer.end()
  ].join('');

  assert.ok(outputs.includes('OpenClaw uses mcp_Bash 中文'));
  assert.ok(outputs.includes('"thinking":"OCPlatform mcp_Bash"'));
  assert.ok(outputs.includes('"thinking_delta","thinking":"OCPlatform mcp_Bash"'));
  assert.ok(outputs.includes('OpenClaw again'));
});

test('SSE stream transform preserves redacted thinking blocks', () => {
  const transformer = createSseStreamTransformer({});
  const outputs = [
    transformer.push('data: {"type":"content_block_start","content_block":{"type":"redacted_thinking","data":"OCPlatform mcp_Bash"}}\n\n'),
    transformer.push('data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"OCPlatform mcp_Bash"}}\n\n'),
    transformer.push('data: {"type":"content_block_stop"}\n\n'),
    transformer.push('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OCPlatform visible"}}\n\n'),
    transformer.end()
  ].join('');

  assert.ok(outputs.includes('"data":"OCPlatform mcp_Bash"'));
  assert.ok(outputs.includes('"signature":"OCPlatform mcp_Bash"'));
  assert.ok(outputs.includes('OpenClaw visible'));
});

test('error response mapping restores runtime names', () => {
  const body = fixtureJson('error-response.json');
  const result = transformErrorBody(body, {});
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.error.message, 'OpenClaw request failed');
  assert.strictEqual(parsed.error.tool.name, 'exec');
  assert.strictEqual(parsed.error.tool.input.session_id, 'thread-1');
});

test('processBody supports explicit Hermes Agent compatibility set', () => {
  const result = processBody(JSON.stringify({
    model: 'claude-sonnet-4-6',
    system: 'Hermes can use delegate_task and mcp_delegate_task.',
    tools: [{ name: 'mcp_delegate_task', description: 'Run Hermes subagent' }],
    messages: [{ role: 'user', content: 'Ask Hermes to delegate_task' }]
  }), {
    compatibilitySets: ['hermes-agent'],
    stripToolDescriptions: false
  }, {
    identity: { deviceId: 'd', sessionId: 's' },
    logger
  });

  assert.ok(result.includes('AssistantRuntime'));
  assert.ok(result.includes('run_worker'));
  assert.ok(result.includes('"name":"mcp_WorkerRun"'));
  assert.ok(!result.includes('OpenClaw'));
});

test('stripEffortFromObject handles empty object removal', () => {
  assert.strictEqual(
    stripEffortFromObject('{"thinking":{"effort":"low"},"keep":true}', 'thinking'),
    '{"keep":true}'
  );
});
