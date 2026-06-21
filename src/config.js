'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_PORT,
  UPSTREAM_HOST
} = require('./constants');
const { defaultCompatibilitySets, resolveCompatibilitySets } = require('./compatibility-sets');

function expandHome(p, homeDir = os.homedir()) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(homeDir, p.slice(1)) : p;
}

function parseArgs(argv) {
  const parsed = {
    configPath: null,
    port: null,
    profile: null
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) parsed.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--config' && argv[i + 1]) parsed.configPath = argv[++i];
    else if (argv[i] === '--profile' && argv[i + 1]) parsed.profile = argv[++i];
  }

  return parsed;
}

function readConfigFile(configPath, cwd = process.cwd()) {
  const resolved = configPath ? path.resolve(cwd, configPath) : path.join(cwd, 'config.json');
  if (!fs.existsSync(resolved)) return {};

  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    if (configPath) throw new Error('Failed to parse config: ' + resolved + ' (' + e.message + ')');
    console.warn('[PROXY] Warning: config.json is invalid, using defaults. (' + e.message + ')');
    return {};
  }
}

function mergePatterns(defaults, overrides) {
  if (!overrides || overrides.length === 0) return defaults;
  const merged = new Map();
  for (const [find, replace] of defaults) merged.set(find, replace);
  for (const [find, replace] of overrides) merged.set(find, replace);
  return [...merged.entries()];
}

function normalizePatterns(config) {
  const useDefaults = config.mergeDefaults !== false;
  const hasExplicitSets = Array.isArray(config.compatibilitySets);
  const setNames = hasExplicitSets
    ? (config.compatibilitySets || [])
    : (useDefaults ? defaultCompatibilitySets() : []);
  const setPatterns = resolveCompatibilitySets(setNames);
  const useSetPatterns = useDefaults || hasExplicitSets;
  const base = useSetPatterns
    ? setPatterns
    : { replacements: [], reverseMap: [], toolRenames: [], propRenames: [] };

  return {
    compatibilitySets: setPatterns.names,
    compatibilitySetOptions: hasExplicitSets ? setPatterns.options : {},
    replacements: useSetPatterns
      ? mergePatterns(base.replacements, config.replacements)
      : (config.replacements || []),
    reverseMap: useSetPatterns
      ? mergePatterns(base.reverseMap, config.reverseMap)
      : (config.reverseMap || []),
    toolRenames: useSetPatterns
      ? mergePatterns(base.toolRenames, config.toolRenames)
      : (config.toolRenames || []),
    propRenames: useSetPatterns
      ? mergePatterns(base.propRenames, config.propRenames)
      : (config.propRenames || [])
  };
}

function discoverCredentialsPath(config, env = process.env, homeDir = os.homedir()) {
  if (env.OAUTH_TOKEN) return null;

  const candidates = [
    config.credentialsPath,
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = expandHome(candidate, homeDir);
    if (fs.existsSync(resolved) && fs.statSync(resolved).size > 0) {
      return resolved;
    }
  }

  return expandHome(config.credentialsPath, homeDir) || null;
}

function normalizeProfiles(config, selectedProfile, env = process.env, homeDir = os.homedir()) {
  const rootProfile = {
    credentialsPath: discoverCredentialsPath(config, env, homeDir),
    tokenEnv: env.OAUTH_TOKEN ? 'OAUTH_TOKEN' : config.tokenEnv,
    stripSystemConfig: config.stripSystemConfig,
    stripToolDescriptions: config.stripToolDescriptions,
    injectCCStubs: config.injectCCStubs,
    stripTrailingAssistantPrefill: config.stripTrailingAssistantPrefill,
    compatibilitySets: config.compatibilitySets,
    mergeDefaults: config.mergeDefaults,
    replacements: config.replacements,
    reverseMap: config.reverseMap,
    toolRenames: config.toolRenames,
    propRenames: config.propRenames
  };

  const profileEntries = config.profiles && typeof config.profiles === 'object'
    ? config.profiles
    : { default: {} };

  const profiles = {};
  for (const [id, profileConfig] of Object.entries(profileEntries)) {
    const merged = {
      ...rootProfile,
      ...profileConfig
    };
    if (Object.prototype.hasOwnProperty.call(profileConfig, 'credentialsPath') &&
        !Object.prototype.hasOwnProperty.call(profileConfig, 'tokenEnv')) {
      merged.tokenEnv = undefined;
    }
    const patterns = normalizePatterns(merged);
    const stripSystemConfig = merged.stripSystemConfig !== undefined
      ? merged.stripSystemConfig !== false
      : patterns.compatibilitySetOptions.stripSystemConfig !== false;
    profiles[id] = {
      id,
      credentialsPath: merged.credentialsPath ? expandHome(merged.credentialsPath, homeDir) : null,
      tokenEnv: merged.tokenEnv,
      compatibilitySets: patterns.compatibilitySets,
      stripSystemConfig,
      stripToolDescriptions: merged.stripToolDescriptions !== false,
      injectCCStubs: merged.injectCCStubs === true,
      stripTrailingAssistantPrefill: merged.stripTrailingAssistantPrefill !== false,
      ...patterns
    };
  }

  const defaultProfile = selectedProfile || env.PROXY_PROFILE || config.profile || config.defaultProfile || Object.keys(profiles)[0];
  if (!profiles[defaultProfile]) {
    throw new Error('Unknown profile "' + defaultProfile + '". Available profiles: ' + Object.keys(profiles).join(', '));
  }

  return { profiles, defaultProfile };
}

function normalizeRouting(config) {
  const routing = config.routing || { type: 'profile', profile: config.profile || config.defaultProfile };
  return {
    type: routing.type || 'profile',
    header: routing.header || config.profileHeader || 'x-sub-model-profile',
    tokens: routing.tokens || {},
    profile: routing.profile
  };
}

function loadConfig(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  const args = parseArgs(argv);
  const rawConfig = readConfigFile(args.configPath, cwd);

  const envPort = env.PROXY_PORT ? parseInt(env.PROXY_PORT, 10) : null;
  const { profiles, defaultProfile } = normalizeProfiles(rawConfig, args.profile, env, homeDir);
  const activeProfile = profiles[defaultProfile];

  return {
    port: envPort || args.port || rawConfig.port || DEFAULT_PORT,
    bindHost: env.PROXY_HOST || rawConfig.bindHost || '127.0.0.1',
    upstream: {
      protocol: rawConfig.upstreamProtocol || 'https:',
      host: rawConfig.upstreamHost || UPSTREAM_HOST,
      port: rawConfig.upstreamPort || 443
    },
    defaultProfile,
    profiles,
    routing: normalizeRouting({ ...rawConfig, profile: defaultProfile }),
    activeProfile,
    // Back-compatible aliases for scripts/tests that still expect flat config.
    credentialsPath: activeProfile.credentialsPath || (activeProfile.tokenEnv ? 'env' : null),
    replacements: activeProfile.replacements,
    reverseMap: activeProfile.reverseMap,
    toolRenames: activeProfile.toolRenames,
    propRenames: activeProfile.propRenames,
    stripSystemConfig: activeProfile.stripSystemConfig,
    stripToolDescriptions: activeProfile.stripToolDescriptions,
    injectCCStubs: activeProfile.injectCCStubs,
    stripTrailingAssistantPrefill: activeProfile.stripTrailingAssistantPrefill
  };
}

module.exports = {
  expandHome,
  parseArgs,
  readConfigFile,
  mergePatterns,
  normalizePatterns,
  discoverCredentialsPath,
  normalizeProfiles,
  normalizeRouting,
  loadConfig
};
