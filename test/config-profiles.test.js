'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadConfig } = require('../src/config');
const { selectProfile } = require('../src/profiles');

function tempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smg-config-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

test('loadConfig treats flat config as default legacy profile', () => {
  const dir = tempConfig({
    port: 19001,
    credentialsPath: '~/custom-creds.json',
    stripSystemConfig: false,
    replacements: [['CustomRuntime', 'Runtime']]
  });

  const config = loadConfig({
    cwd: dir,
    homeDir: '/home/tester',
    env: {}
  });

  assert.strictEqual(config.port, 19001);
  assert.strictEqual(config.defaultProfile, 'default');
  assert.strictEqual(config.credentialsPath, '/home/tester/custom-creds.json');
  assert.strictEqual(config.activeProfile.stripSystemConfig, false);
  assert.ok(config.activeProfile.replacements.some(([from, to]) => from === 'CustomRuntime' && to === 'Runtime'));
});

test('loadConfig selects named profile from CLI/env/config precedence', () => {
  const dir = tempConfig({
    profile: 'runtime',
    credentialsPath: '~/root-creds.json',
    profiles: {
      runtime: { stripToolDescriptions: false },
      family: { credentialsPath: '~/family-creds.json' }
    }
  });

  const envSelected = loadConfig({
    cwd: dir,
    homeDir: '/home/tester',
    env: { PROXY_PROFILE: 'family' }
  });
  assert.strictEqual(envSelected.defaultProfile, 'family');
  assert.strictEqual(envSelected.credentialsPath, '/home/tester/family-creds.json');

  const cliSelected = loadConfig({
    cwd: dir,
    homeDir: '/home/tester',
    argv: ['--profile', 'runtime'],
    env: { PROXY_PROFILE: 'family' }
  });
  assert.strictEqual(cliSelected.defaultProfile, 'runtime');
  assert.strictEqual(cliSelected.activeProfile.stripToolDescriptions, false);
});

test('profile credentialsPath overrides legacy OAUTH_TOKEN root default', () => {
  const dir = tempConfig({
    profiles: {
      envProfile: {},
      fileProfile: { credentialsPath: '~/family-creds.json' }
    }
  });

  const config = loadConfig({
    cwd: dir,
    homeDir: '/home/tester',
    argv: ['--profile', 'fileProfile'],
    env: { OAUTH_TOKEN: 'sk-env' }
  });

  assert.strictEqual(config.defaultProfile, 'fileProfile');
  assert.strictEqual(config.activeProfile.credentialsPath, '/home/tester/family-creds.json');
  assert.strictEqual(config.activeProfile.tokenEnv, undefined);
  assert.strictEqual(config.profiles.envProfile.tokenEnv, 'OAUTH_TOKEN');
});

test('compatibilitySets can select Hermes Agent rules per profile', () => {
  const dir = tempConfig({
    profile: 'hermes',
    compatibilitySets: ['openclaw'],
    profiles: {
      hermes: {
        compatibilitySets: ['hermes']
      }
    }
  });

  const config = loadConfig({
    cwd: dir,
    homeDir: '/home/tester',
    env: { OAUTH_TOKEN: 'sk-env' }
  });

  assert.deepStrictEqual(config.activeProfile.compatibilitySets, ['hermes']);
  assert.ok(config.activeProfile.replacements.some(([from, to]) => from === 'Hermes' && to === 'AssistantRuntime'));
  assert.ok(config.activeProfile.toolRenames.some(([from, to]) => from === 'mcp_delegate_task' && to === 'mcp_SubagentRun'));
  assert.strictEqual(config.activeProfile.stripSystemConfig, false);
  assert.ok(!config.activeProfile.replacements.some(([from]) => from === 'OpenClaw'));
});

test('compatibilitySets can combine or disable built-in rule sets', () => {
  const combinedDir = tempConfig({
    compatibilitySets: ['openclaw', 'hermes']
  });
  const combined = loadConfig({
    cwd: combinedDir,
    homeDir: '/home/tester',
    env: { OAUTH_TOKEN: 'sk-env' }
  });
  assert.ok(combined.activeProfile.replacements.some(([from]) => from === 'OpenClaw'));
  assert.ok(combined.activeProfile.replacements.some(([from]) => from === 'Hermes'));

  const disabledDir = tempConfig({
    compatibilitySets: [],
    replacements: [['CustomRuntime', 'RuntimeCLI']]
  });
  const disabled = loadConfig({
    cwd: disabledDir,
    homeDir: '/home/tester',
    env: { OAUTH_TOKEN: 'sk-env' }
  });
  assert.deepStrictEqual(disabled.activeProfile.compatibilitySets, []);
  assert.deepStrictEqual(disabled.activeProfile.replacements, [['CustomRuntime', 'RuntimeCLI']]);
  assert.deepStrictEqual(disabled.activeProfile.toolRenames, []);
});

test('selectProfile supports default, header, and client-token routing', () => {
  const base = {
    defaultProfile: 'runtime',
    profiles: {
      runtime: { id: 'runtime' },
      family: { id: 'family' }
    }
  };

  assert.deepStrictEqual(
    selectProfile({ headers: {} }, { ...base, routing: { type: 'profile' } }),
    { profileId: 'runtime' }
  );

  assert.deepStrictEqual(
    selectProfile({ headers: { 'x-sub-model-profile': 'family' } }, {
      ...base,
      routing: { type: 'header', header: 'x-sub-model-profile' }
    }),
    { profileId: 'family' }
  );

  assert.deepStrictEqual(
    selectProfile({ headers: { authorization: 'Bearer local-family' } }, {
      ...base,
      routing: { type: 'clientToken', tokens: { 'local-family': 'family' } }
    }),
    { profileId: 'family' }
  );

  const rejected = selectProfile({ headers: { authorization: 'Bearer unknown' } }, {
    ...base,
    routing: { type: 'clientToken', tokens: { 'local-family': 'family' } }
  });
  assert.strictEqual(rejected.error.status, 403);
});
