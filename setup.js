#!/usr/bin/env node
'use strict';

/**
 * Setup script for Sub Model Gateway
 *
 * Auto-detects OpenClaw configuration, scans for sessions_* tools,
 * and generates profile-shaped gateway configuration.
 *
 * Usage:
 *   node setup.js [--profile runtime] [--port 18801] [--config config.json]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, loadConfig } = require('./src/config');
const {
  buildSetupConfig,
  defaultPatternCounts,
  findClaudeCredentials,
  findRuntimeConfig,
  getRuntimeBaseUrl,
  writeCredentialsFile
} = require('./src/setup-helpers');
const { listCompatibilitySets } = require('./src/compatibility-sets');

function parseCompatibilitySets(argv) {
  const sets = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--set' || argv[i] === '--compatibility-set') && argv[i + 1]) {
      for (const set of argv[++i].split(',')) {
        const trimmed = set.trim();
        if (trimmed) sets.push(trimmed);
      }
    }
    if (argv[i] === '--no-sets') {
      return [];
    }
  }
  return sets.length > 0 ? sets : ['openclaw'];
}

function findDistPaths(runtimePath, homeDir) {
  const runtimeDir = path.dirname(runtimePath);
  const distPaths = [
    path.join(runtimeDir, '..', 'node_modules', 'openclaw', 'dist'),
    '/usr/lib/node_modules/openclaw/dist',
    path.join(homeDir, '.npm-global', 'lib', 'node_modules', 'openclaw', 'dist')
  ];

  if (process.platform === 'win32') {
    distPaths.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'dist'));
  }

  const nvmDir = path.join(homeDir, '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmDir)) {
    try {
      for (const version of fs.readdirSync(nvmDir)) {
        distPaths.push(path.join(nvmDir, version, 'lib', 'node_modules', 'openclaw', 'dist'));
      }
    } catch (e) {
      // Skip unreadable nvm directories.
    }
  }

  return distPaths;
}

function scanSessionTools(distPaths) {
  for (const distPath of distPaths) {
    if (!fs.existsSync(distPath)) continue;
    const sessionTools = [];
    try {
      const files = fs.readdirSync(distPath).filter((f) => f.endsWith('.js'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(distPath, file), 'utf8');
        const matches = content.match(/sessions_[a-z_]+/g);
        if (matches) {
          for (const match of matches) {
            if (!sessionTools.includes(match)) sessionTools.push(match);
          }
        }
      }
      if (sessionTools.length > 0) {
        return { distPath, sessionTools };
      }
    } catch (e) {
      // Try the next candidate.
    }
  }

  return {
    distPath: null,
    sessionTools: ['sessions_spawn', 'sessions_list', 'sessions_history', 'sessions_send', 'sessions_yield_interrupt', 'sessions_yield', 'sessions_store'],
    fallback: true
  };
}

function logRuntimeScan(runtimePath, runtimeConfig, homeDir) {
  console.log('\n3. Scanning for session management tools...');

  const distPaths = findDistPaths(runtimePath, homeDir);
  const scan = scanSessionTools(distPaths);
  if (scan.distPath) {
    console.log('   Found OpenClaw dist at: ' + scan.distPath);
    console.log('   Detected sessions_* tools: ' + scan.sessionTools.join(', '));
  } else {
    console.log('   Using default sessions_* tool list (could not scan source)');
  }

  const sessionReplacements = {
    'sessions_spawn': 'create_task',
    'sessions_list': 'list_tasks',
    'sessions_history': 'get_history',
    'sessions_send': 'send_to_task',
    'sessions_yield_interrupt': 'task_yield_interrupt',
    'sessions_yield': 'yield_task',
    'sessions_store': 'task_store'
  };

  for (const tool of scan.sessionTools) {
    const replacement = sessionReplacements[tool] || tool.replace('sessions_', 'task_');
    console.log('   ' + tool + ' -> ' + replacement);
  }

  const workspaceDir = runtimeConfig.agents &&
    runtimeConfig.agents.defaults &&
    runtimeConfig.agents.defaults.workspace;
  if (workspaceDir) {
    const identityFiles = ['SOUL.md', 'USER.md', 'AGENTS.md'];
    for (const file of identityFiles) {
      const filePath = path.join(workspaceDir, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const nameMatch = content.match(/(?:name|assistant|bot)\s*[:=]\s*["']?(\w+)/i);
      if (nameMatch && nameMatch[1].length > 2 && !['the', 'you', 'your', 'this'].includes(nameMatch[1].toLowerCase())) {
        console.log('\n   Detected assistant name: ' + nameMatch[1]);
        console.log('   Note: Assistant names are usually NOT blocked by Anthropic.');
        console.log('   If requests fail, try adding it to replacements as a test.');
        break;
      }
    }
  }

  for (const distPath of distPaths) {
    if (!fs.existsSync(distPath)) continue;
    try {
      const indexFile = fs.readdirSync(distPath).find((f) => f.startsWith('index'));
      if (!indexFile) break;
      const content = fs.readFileSync(path.join(distPath, indexFile), 'utf8');
      if (content.includes('clawhub')) console.log('   Added clawhub sanitization');
      if (content.includes('clawd')) console.log('   Added clawd sanitization');
      break;
    } catch (e) {
      // Try the next candidate.
    }
  }
}

function findHermesConfig(homeDir) {
  const candidates = [
    process.env.HERMES_AGENT_CONFIG,
    path.join(homeDir, '.hermes-agent', 'config.json'),
    path.join(homeDir, '.hermes-agent', 'hermes-agent.json'),
    path.join(homeDir, '.hermes', 'hermes-agent.json')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function printMissingCredentials(result, homeDir) {
  console.error('   CREDENTIALS NOT FOUND.');
  console.error('');
  console.error('   Claude Code CLI must be installed and authenticated:');
  console.error('');
  console.error('     npm install -g @anthropic-ai/claude-code');
  console.error('     claude auth login');
  console.error('');
  console.error('   This opens a browser to sign in with your Claude Max/Pro account.');
  console.error('   After authenticating, run this setup script again.');
  console.error('');
  console.error('   Searched for credentials at:');
  for (const checked of (result.checked || [])) {
    const detail = checked.exists
      ? ' (' + (checked.reason || (checked.size + ' bytes')) + ')'
      : '';
    console.error('     ' + checked.path + detail);
    if (checked.keys) console.error('       keys: ' + checked.keys.join(', '));
  }
  if (process.platform === 'darwin') {
    console.error('     macOS Keychain (Claude Code-credentials, claude-code, claude, com.anthropic.claude-code)');
  }
  console.error('');
  console.error('   If claude auth status shows you are logged in but no claudeAiOauth credential exists,');
  console.error('   your Claude Code version may store tokens elsewhere.');
  console.error('   Run: claude -p "test" --max-turns 1 --no-session-persistence');
  console.error('   Then try this setup again.');
  console.error('');
  console.error('   Home directory checked: ' + homeDir);
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const homeDir = os.homedir();
  const profile = args.profile || process.env.PROXY_PROFILE || 'runtime';
  const compatibilitySets = parseCompatibilitySets(argv);
  const port = args.port || (process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : undefined);
  const configPath = path.resolve(process.cwd(), args.configPath || 'config.json');

  console.log('\n  Sub Model Gateway Setup');
  console.log('  -----------------------\n');

  console.log('1. Checking Claude Code authentication...');
  const credentialResult = findClaudeCredentials({
    homeDir,
    triggerClaudeWrite: true
  });

  if (!credentialResult.ok) {
    printMissingCredentials(credentialResult, homeDir);
    process.exit(1);
  }

  let credentialsPath = credentialResult.path;
  if (credentialResult.source === 'keychain') {
    credentialsPath = writeCredentialsFile(credentialResult.creds, { homeDir });
    console.log('   Extracted credentials from macOS Keychain service: ' + credentialResult.service);
    console.log('   Written credentials to: ' + credentialsPath);
  }

  const expiresIn = ((credentialResult.oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
  console.log('   OK: ' + (credentialResult.oauth.subscriptionType || 'unknown') + ' subscription, token expires in ' + expiresIn + 'h');

  console.log('\n2. Finding runtime configuration...');
  const openClawEnabled = compatibilitySets.includes('openclaw');
  const hermesEnabled = compatibilitySets.includes('hermes');
  const runtimePath = openClawEnabled ? findRuntimeConfig(homeDir) : null;
  const hermesPath = hermesEnabled ? findHermesConfig(homeDir) : null;
  let runtimeConfig = null;
  if (runtimePath) {
    try {
      runtimeConfig = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      console.log('   Found OpenClaw: ' + runtimePath);
      console.log('   Current baseUrl: ' + (getRuntimeBaseUrl(runtimeConfig) || 'unknown'));
    } catch (e) {
      console.log('   Found OpenClaw: ' + runtimePath + ' (could not parse: ' + e.message + ')');
    }
  } else if (openClawEnabled) {
    console.log('   OpenClaw config not found (using defaults)');
  }
  if (hermesPath) {
    console.log('   Found Hermes Agent: ' + hermesPath);
  } else if (hermesEnabled) {
    console.log('   Hermes Agent config not found in known paths');
    console.log('   Set HERMES_AGENT_CONFIG to point setup/troubleshoot at a custom Hermes Agent config path.');
  }

  if (openClawEnabled && runtimePath && runtimeConfig) {
    logRuntimeScan(runtimePath, runtimeConfig, homeDir);
  } else if (openClawEnabled) {
    console.log('\n3. Scanning for session management tools...');
    console.log('   Using default sessions_* tool list (could not scan source)');
    const defaults = [
      ['sessions_spawn', 'create_task'],
      ['sessions_list', 'list_tasks'],
      ['sessions_history', 'get_history'],
      ['sessions_send', 'send_to_task'],
      ['sessions_yield', 'yield_task']
    ];
    for (const [tool, replacement] of defaults) {
      console.log('   ' + tool + ' -> ' + replacement);
    }
  } else {
    console.log('\n3. Scanning for session management tools...');
    console.log('   OpenClaw set disabled; skipping OpenClaw sessions_* scan');
  }

  if (hermesEnabled) {
    console.log('   Hermes set enabled; using built-in Hermes compatibility rules');
  }

  console.log('\n4. Generating configuration...');
  const config = buildSetupConfig({
    port,
    profile,
    credentialsPath,
    compatibilitySets
  });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // Validate the generated file through the same loader used by proxy.js.
  loadConfig({
    argv: ['--config', configPath, '--profile', profile],
    env: {},
    cwd: process.cwd(),
    homeDir
  });

  const counts = defaultPatternCounts();
  console.log('   Written: ' + configPath);
  console.log('   Profile: ' + profile);
  console.log('   Compatibility sets: ' + (compatibilitySets.length ? compatibilitySets.join(', ') : 'none'));
  console.log('   Credentials: ' + credentialsPath);
  console.log('   Default sanitization: ' + counts.replacements + ' string + ' + counts.toolRenames + ' tool renames (from src/constants.js)');
  console.log('   Custom patterns can be added at the root or under profiles.' + profile + '.');
  console.log('   Available compatibility sets: ' + listCompatibilitySets().join(', '));

  console.log('\n5. Setup complete!\n');
  console.log('   Next steps:');
  console.log('   -----------');
  console.log('   a) Start the gateway:   node proxy.js --profile ' + profile);
  console.log('   b) Update client:       Set its baseUrl to http://127.0.0.1:' + config.port);
  console.log('   c) Restart runtime:     Restart the client runtime');
  console.log('   d) Test:                node troubleshoot.js --profile ' + profile + '\n');

  if (runtimePath) {
    console.log('   To update baseUrl automatically:');
    if (process.platform === 'win32') {
      console.log('     powershell -c "(gc \'' + runtimePath + '\') -replace \'\\\"baseUrl\\\":\\s*\\\"[^\\\"]*\\\"\', \'\\\"baseUrl\\\": \\\"http://127.0.0.1:' + config.port + '\\\"\' | sc \'' + runtimePath + '\'"');
    } else {
      console.log('     sed -i \'s|"baseUrl": "[^"]*"|"baseUrl": "http://127.0.0.1:' + config.port + '"|\' \'' + runtimePath + '\'');
    }
  }

  console.log('\n   Troubleshooting:');
  console.log('   - If requests fail with "extra usage" errors, check proxy console for 400 status codes');
  console.log('   - Add any runtime-specific tools to both replacements and reverseMap in config.json');
  console.log('   - If your runtime name is blocked, add it to replacements and reverseMap');
  console.log('   - Token refreshes automatically when the proxy can refresh the selected profile token');
}

if (require.main === module) {
  main();
}

module.exports = {
  main
};
