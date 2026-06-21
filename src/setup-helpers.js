'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync: defaultExecSync } = require('child_process');
const {
  DEFAULT_PORT,
  DEFAULT_REPLACEMENTS,
  DEFAULT_TOOL_RENAMES
} = require('./constants');
const { stripBom } = require('./token-store');

const KEYCHAIN_SERVICE_NAMES = [
  'Claude Code-credentials',
  'claude-code',
  'claude',
  'com.anthropic.claude-code'
];

function credentialsPaths(homeDir = os.homedir()) {
  return [
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json')
  ];
}

function parseCredentialPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (e) {
    return { ok: false, reason: 'invalid-json', message: e.message };
  }

  const oauth = parsed.claudeAiOauth;
  if (oauth && oauth.accessToken) {
    return { ok: true, creds: parsed, oauth };
  }

  return {
    ok: false,
    reason: 'missing-claude-ai-oauth',
    keys: Object.keys(parsed)
  };
}

function parseKeychainPayload(token) {
  const parsed = parseCredentialPayload(token);
  if (parsed.ok) return parsed;

  if (typeof token === 'string' && token.startsWith('sk-ant-')) {
    const creds = {
      claudeAiOauth: {
        accessToken: token,
        expiresAt: Date.now() + 86400000,
        subscriptionType: 'unknown'
      }
    };
    return { ok: true, creds, oauth: creds.claudeAiOauth, rawToken: true };
  }

  return parsed;
}

function findFileCredentials(options = {}) {
  const fsImpl = options.fs || fs;
  const paths = options.paths || credentialsPaths(options.homeDir);
  const checked = [];

  for (const p of paths) {
    if (!fsImpl.existsSync(p)) {
      checked.push({ path: p, exists: false });
      continue;
    }
    const stat = fsImpl.statSync(p);
    if (stat.size === 0) {
      checked.push({ path: p, exists: true, size: 0, reason: 'empty' });
      continue;
    }

    const parsed = parseCredentialPayload(fsImpl.readFileSync(p, 'utf8'));
    if (parsed.ok) {
      return {
        ok: true,
        source: 'file',
        path: p,
        creds: parsed.creds,
        oauth: parsed.oauth,
        checked
      };
    }
    checked.push({
      path: p,
      exists: true,
      size: stat.size,
      reason: parsed.reason,
      keys: parsed.keys
    });
  }

  return { ok: false, checked };
}

function findKeychainCredentials(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    return { ok: false, skipped: true };
  }

  const execSync = options.execSync || defaultExecSync;
  for (const service of (options.serviceNames || KEYCHAIN_SERVICE_NAMES)) {
    try {
      const token = execSync('security find-generic-password -s "' + service + '" -w 2>/dev/null', { encoding: 'utf8' }).trim();
      if (!token) continue;
      const parsed = parseKeychainPayload(token);
      if (parsed.ok) {
        return {
          ok: true,
          source: 'keychain',
          service,
          creds: parsed.creds,
          oauth: parsed.oauth,
          rawToken: parsed.rawToken === true
        };
      }
    } catch (e) {
      // Try the next service name.
    }
  }

  return { ok: false };
}

function writeCredentialsFile(creds, options = {}) {
  const fsImpl = options.fs || fs;
  const homeDir = options.homeDir || os.homedir();
  const credsPath = options.path || path.join(homeDir, '.claude', '.credentials.json');
  fsImpl.mkdirSync(path.dirname(credsPath), { recursive: true });
  fsImpl.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
  return credsPath;
}

function triggerClaudeCredentialWrite(options = {}) {
  const execSync = options.execSync || defaultExecSync;
  try {
    execSync('claude -p "ping" --max-turns 1 --no-session-persistence --output-format json 2>/dev/null', {
      timeout: 30000,
      stdio: 'pipe'
    });
    return true;
  } catch (e) {
    return false;
  }
}

function findClaudeCredentials(options = {}) {
  const fileResult = findFileCredentials(options);
  if (fileResult.ok) return fileResult;

  const keychainResult = findKeychainCredentials(options);
  if (keychainResult.ok) return keychainResult;

  if (options.triggerClaudeWrite) {
    const triggered = triggerClaudeCredentialWrite(options);
    if (triggered) {
      const retry = findFileCredentials(options);
      if (retry.ok) return { ...retry, source: 'file-after-claude-ping' };
    }
  }

  return {
    ok: false,
    checked: fileResult.checked,
    keychainChecked: !keychainResult.skipped
  };
}

function buildSetupConfig(options = {}) {
  const profile = options.profile || 'runtime';
  const credentialsPath = options.credentialsPath || '~/.claude/.credentials.json';
  const compatibilitySets = options.compatibilitySets || ['openclaw'];
  return {
    port: options.port || DEFAULT_PORT,
    profile,
    credentialsPath,
    compatibilitySets,
    routing: {
      type: 'profile'
    },
    profiles: {
      [profile]: {}
    },
    _comment: 'Root fields are defaults for profiles. Add profiles.<name>.credentialsPath and routing.type=\"clientToken\" for multiple subscriptions.',
    _comment_sets: 'Set compatibilitySets to [\"openclaw\"], [\"hermes-agent\"], both, or [] to control runtime compatibility rules.',
    _comment_patterns: 'Pattern arrays use src/constants.js defaults. Add custom replacements/reverseMap/toolRenames/propRenames at the root or profile level and they will be merged with defaults.'
  };
}

function findRuntimeConfig(homeDir = os.homedir(), fsImpl = fs) {
  const candidates = [
    path.join(homeDir, '.openclaw', 'openclaw.json'),
    path.join(homeDir, '.openclaw', 'config.json'),
    '/etc/openclaw/openclaw.json'
  ];
  return candidates.find((p) => fsImpl.existsSync(p)) || null;
}

function getRuntimeBaseUrl(config) {
  return config.models &&
    config.models.providers &&
    config.models.providers.anthropic &&
    config.models.providers.anthropic.baseUrl;
}

function defaultPatternCounts() {
  return {
    replacements: DEFAULT_REPLACEMENTS.length,
    toolRenames: DEFAULT_TOOL_RENAMES.length
  };
}

module.exports = {
  KEYCHAIN_SERVICE_NAMES,
  credentialsPaths,
  parseCredentialPayload,
  parseKeychainPayload,
  findFileCredentials,
  findKeychainCredentials,
  writeCredentialsFile,
  triggerClaudeCredentialWrite,
  findClaudeCredentials,
  buildSetupConfig,
  findRuntimeConfig,
  getRuntimeBaseUrl,
  defaultPatternCounts
};
