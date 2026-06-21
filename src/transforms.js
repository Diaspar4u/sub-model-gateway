'use strict';

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const {
  BILLING_HASH_INDICES,
  BILLING_HASH_SALT,
  CC_TOOL_STUBS,
  CC_VERSION,
  REQUIRED_BETAS
} = require('./constants');
const { resolveCompatibilitySets } = require('./compatibility-sets');

function createRuntimeIdentity() {
  return {
    deviceId: crypto.randomBytes(32).toString('hex'),
    sessionId: crypto.randomUUID()
  };
}

function normalizeTransformConfig(config) {
  const hasExplicitSets = Array.isArray(config.compatibilitySets);
  const setPatterns = hasExplicitSets
    ? resolveCompatibilitySets(config.compatibilitySets || [])
    : resolveCompatibilitySets();
  return {
    ...config,
    replacements: config.replacements || setPatterns.replacements,
    reverseMap: config.reverseMap || setPatterns.reverseMap,
    toolRenames: config.toolRenames || setPatterns.toolRenames,
    propRenames: config.propRenames || setPatterns.propRenames,
    stripSystemConfig: config.stripSystemConfig !== false,
    stripToolDescriptions: config.stripToolDescriptions !== false,
    injectCCStubs: config.injectCCStubs === true,
    stripTrailingAssistantPrefill: config.stripTrailingAssistantPrefill !== false
  };
}

function getModelBetas(modelId) {
  const m = (modelId || '').toLowerCase();
  const betas = [...REQUIRED_BETAS];
  // Haiku cannot handle interleaved-thinking - it 400s.
  if (m.includes('haiku')) {
    const idx = betas.indexOf('interleaved-thinking-2025-05-14');
    if (idx !== -1) betas.splice(idx, 1);
  }
  if (m.includes('4-6') || m.includes('4_6')) {
    if (!betas.includes('effort-2025-11-24')) betas.push('effort-2025-11-24');
  }
  return betas;
}

function computeBillingFingerprint(firstUserText) {
  const chars = BILLING_HASH_INDICES.map(i => firstUserText[i] || '0').join('');
  const input = `${BILLING_HASH_SALT}${chars}${CC_VERSION}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 3);
}

function extractFirstUserText(bodyStr) {
  const msgsIdx = bodyStr.indexOf('"messages":[');
  if (msgsIdx === -1) return '';
  const userIdx = bodyStr.indexOf('"role":"user"', msgsIdx);
  if (userIdx === -1) return '';

  const contentIdx = bodyStr.indexOf('"content"', userIdx);
  if (contentIdx === -1 || contentIdx > userIdx + 500) return '';

  const afterContent = bodyStr[contentIdx + '"content"'.length + 1];
  if (afterContent === '"') {
    const textStart = contentIdx + '"content":"'.length;
    let end = textStart;
    while (end < bodyStr.length) {
      if (bodyStr[end] === '\\') { end += 2; continue; }
      if (bodyStr[end] === '"') break;
      end++;
    }
    return bodyStr.slice(textStart, end)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  const textIdx = bodyStr.indexOf('"text":"', contentIdx);
  if (textIdx === -1 || textIdx > contentIdx + 2000) return '';
  const textStart = textIdx + '"text":"'.length;
  let end = textStart;
  while (end < bodyStr.length) {
    if (bodyStr[end] === '\\') { end += 2; continue; }
    if (bodyStr[end] === '"') break;
    end++;
  }
  return bodyStr.slice(textStart, Math.min(end, textStart + 50))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function computeCch(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 5);
}

function buildBillingBlock(bodyStr, preExtractedText) {
  const firstText = preExtractedText !== undefined ? preExtractedText : extractFirstUserText(bodyStr);
  const fingerprint = computeBillingFingerprint(firstText);
  const ccVersion = `${CC_VERSION}.${fingerprint}`;
  const cch = computeCch(firstText);
  return `{"type":"text","text":"x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=cli; cch=${cch};"}`;
}

function getStainlessHeaders(identity) {
  const runtimeIdentity = identity || createRuntimeIdentity();
  const p = process.platform;
  const osName = p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return {
    'user-agent': `claude-cli/${CC_VERSION} (external, cli)`,
    'x-app': 'cli',
    'x-claude-code-session-id': runtimeIdentity.sessionId,
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': osName,
    'x-stainless-package-version': '0.90.0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

function findMatchingBracket(str, start) {
  let d = 0, inStr = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') d++;
    else if (c === ']') { d--; if (d === 0) return i; }
  }
  return -1;
}

function findMatchingBrace(str, start) {
  let d = 0, inStr = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

function stripEffortFromObject(str, objectKey) {
  const keyPattern = '"' + objectKey + '"';
  let pos = str.indexOf(keyPattern);
  if (pos === -1) return str;
  let braceStart = str.indexOf('{', pos + keyPattern.length);
  if (braceStart === -1) return str;
  const braceEnd = findMatchingBrace(str, braceStart);
  if (braceEnd === -1) return str;

  const inner = str.slice(braceStart + 1, braceEnd);
  let cleaned = inner
    .replace(/,\s*"effort"\s*:\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false|null)/, '')
    .replace(/"effort"\s*:\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false|null),?\s*/, '');
  cleaned = cleaned.replace(/,\s*$/, '').trim();

  if (cleaned === '') {
    const keyStart = str.lastIndexOf(',', pos);
    if (keyStart !== -1 && str.slice(keyStart, pos).trim() === ',') {
      return str.slice(0, keyStart) + str.slice(braceEnd + 1);
    }
    let removeTo = braceEnd + 1;
    while (removeTo < str.length && /\s/.test(str[removeTo])) removeTo++;
    if (str[removeTo] === ',') removeTo++;
    return str.slice(0, pos) + str.slice(removeTo);
  }

  return str.slice(0, braceStart + 1) + cleaned + str.slice(braceEnd);
}

const THINK_MASK_PREFIX = '__OBP_THINK_MASK_';
const THINK_MASK_SUFFIX = '__';
const THINK_BLOCK_PATTERNS = ['{"type":"thinking"', '{"type":"redacted_thinking"'];
const OPAQUE_MASK_PREFIX = '__OBP_OPAQUE_MASK_';
const OPAQUE_MASK_SUFFIX = '__';

function maskThinkingBlocks(m) {
  const masks = [];
  let out = '';
  let i = 0;
  while (i < m.length) {
    let nextIdx = -1;
    for (const p of THINK_BLOCK_PATTERNS) {
      const idx = m.indexOf(p, i);
      if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) nextIdx = idx;
    }
    if (nextIdx === -1) { out += m.slice(i); break; }
    out += m.slice(i, nextIdx);
    let depth = 0, inStr = false, j = nextIdx;
    while (j < m.length) {
      const c = m[j];
      if (inStr) {
        if (c === '\\') { j += 2; continue; }
        if (c === '"') inStr = false;
        j++;
        continue;
      }
      if (c === '"') { inStr = true; j++; continue; }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; if (depth === 0) break; continue; }
      j++;
    }
    if (depth !== 0) {
      out += m.slice(nextIdx);
      return { masked: out, masks };
    }
    masks.push(m.slice(nextIdx, j));
    out += THINK_MASK_PREFIX + (masks.length - 1) + THINK_MASK_SUFFIX;
    i = j;
  }
  return { masked: out, masks };
}

function unmaskThinkingBlocks(m, masks) {
  for (let i = 0; i < masks.length; i++) {
    m = m.split(THINK_MASK_PREFIX + i + THINK_MASK_SUFFIX).join(masks[i]);
  }
  return m;
}

function isLikelyBase64Payload(value, minLength = 256) {
  if (typeof value !== 'string' || value.length < minLength) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function shouldMaskOpaqueValue(pattern, rawValue, prefixContext = '') {
  if (pattern === '"url":"data:') {
    const comma = rawValue.indexOf(',');
    if (comma === -1) return false;
    return rawValue.slice(0, comma).includes(';base64')
      && isLikelyBase64Payload(rawValue.slice(comma + 1), 4);
  }
  if (pattern === '"base64":"') {
    return isLikelyBase64Payload(rawValue, 4);
  }
  if (prefixContext.includes('"type":"base64"') || prefixContext.includes('"media_type":"image/')) {
    return isLikelyBase64Payload(rawValue, 4);
  }
  return isLikelyBase64Payload(rawValue);
}

function maskOpaquePayloads(m) {
  const masks = [];
  const patterns = ['"data":"', '"base64":"', '"url":"data:'];
  let out = '';
  let i = 0;

  while (i < m.length) {
    let nextIdx = -1;
    let nextPattern = '';
    for (const pattern of patterns) {
      const idx = m.indexOf(pattern, i);
      if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
        nextIdx = idx;
        nextPattern = pattern;
      }
    }

    if (nextIdx === -1) { out += m.slice(i); break; }

    const valueStart = nextIdx + nextPattern.length;
    let j = valueStart;
    while (j < m.length) {
      if (m[j] === '\\') { j += 2; continue; }
      if (m[j] === '"') break;
      j++;
    }

    if (j >= m.length) {
      out += m.slice(i);
      break;
    }

    const rawValue = m.slice(valueStart, j);
    const prefixContext = m.slice(Math.max(0, nextIdx - 160), nextIdx);
    if (!shouldMaskOpaqueValue(nextPattern, rawValue, prefixContext)) {
      out += m.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    masks.push(rawValue);
    out += m.slice(i, valueStart) + OPAQUE_MASK_PREFIX + (masks.length - 1) + OPAQUE_MASK_SUFFIX;
    i = j;
  }

  return { masked: out, masks };
}

function unmaskOpaquePayloads(m, masks) {
  for (let i = 0; i < masks.length; i++) {
    m = m.split(OPAQUE_MASK_PREFIX + i + OPAQUE_MASK_SUFFIX).join(masks[i]);
  }
  return m;
}

function repairToolPairs(bodyStr, logger = console) {
  const msgsStart = bodyStr.indexOf('"messages":[');
  if (msgsStart === -1) return bodyStr;

  const arrayOpenIdx = msgsStart + '"messages":'.length;
  const arrayCloseIdx = findMatchingBracket(bodyStr, arrayOpenIdx);
  if (arrayCloseIdx === -1) return bodyStr;

  const messagesJson = bodyStr.slice(arrayOpenIdx, arrayCloseIdx + 1);
  let messages;
  try {
    messages = JSON.parse(messagesJson);
  } catch (e) {
    logger.warn('[REPAIR] Could not parse messages array:', e.message);
    return bodyStr;
  }

  if (!Array.isArray(messages)) return bodyStr;

  const toolUseIds = new Set();
  const toolResultIds = new Set();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolUseIds.add(block.id);
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const orphanedUses = new Set();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUses.add(id);
  }
  const orphanedResults = new Set();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResults.add(id);
  }

  if (orphanedUses.size === 0 && orphanedResults.size === 0) return bodyStr;

  logger.log(`[REPAIR] Removing ${orphanedUses.size} orphaned tool_use and ${orphanedResults.size} orphaned tool_result blocks`);

  const candidateRepaired = messages
    .map((message) => {
      if (!Array.isArray(message.content)) return message;
      const filtered = message.content.filter((block) => {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          return !orphanedUses.has(block.id);
        }
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          return !orphanedResults.has(block.tool_use_id);
        }
        return true;
      });
      if (filtered.length === 0) return null;
      return { ...message, content: filtered };
    });

  const repaired = [];
  for (let i = 0; i < candidateRepaired.length; i++) {
    if (candidateRepaired[i] !== null) {
      repaired.push(candidateRepaired[i]);
    } else {
      const prevRole = repaired.length > 0 ? repaired[repaired.length - 1].role : null;
      const nextMsg = candidateRepaired.slice(i + 1).find(m => m !== null);
      const nextRole = nextMsg ? nextMsg.role : null;
      if (prevRole && nextRole && prevRole === nextRole) {
        repaired.push({ ...messages[i], content: [{ type: 'text', text: '(removed)' }] });
      }
    }
  }

  const repairedJson = JSON.stringify(repaired);
  return bodyStr.slice(0, arrayOpenIdx) + repairedJson + bodyStr.slice(arrayCloseIdx + 1);
}

function processBody(bodyStr, config, options = {}) {
  const transformConfig = normalizeTransformConfig(config || {});
  const identity = options.identity || createRuntimeIdentity();
  const logger = options.logger || console;

  bodyStr = repairToolPairs(bodyStr, logger);

  const originalFirstUserText = extractFirstUserText(bodyStr);
  const { masked: maskedBody, masks: thinkMasks } = maskThinkingBlocks(bodyStr);
  const { masked: opaqueMaskedBody, masks: opaqueMasks } = maskOpaquePayloads(maskedBody);
  let m = opaqueMaskedBody;

  for (const [find, replace] of transformConfig.replacements) {
    m = m.split(find).join(replace);
  }

  {
    const modelMatch = /"model"\s*:\s*"([^"]+)"/.exec(m);
    if (modelMatch && modelMatch[1].toLowerCase().includes('haiku')) {
      m = stripEffortFromObject(m, 'output_config');
      m = stripEffortFromObject(m, 'thinking');
      logger.log('[EFFORT] Stripped effort param for Haiku model: ' + modelMatch[1]);
    }
  }

  for (const [orig, cc] of transformConfig.toolRenames) {
    m = m.split('"' + orig + '"').join('"' + cc + '"');
  }

  for (const [orig, renamed] of transformConfig.propRenames) {
    m = m.split('"' + orig + '"').join('"' + renamed + '"');
  }

  if (transformConfig.stripSystemConfig) {
    const IDENTITY_MARKERS = [
      'You are a personal assistant',
      'You are an AI assistant',
      'You are a helpful assistant',
      'You are an intelligent assistant',
      'You are an AI agent',
      'You are an agent',
    ];

    const END_BOUNDARY_PATTERNS = [
      '\\n## /',
      '\\n## \\\\\\\\',
      '\\n## //',
    ];

    const sysArrayStart = m.indexOf('"system":[');
    let sysArrayEnd = -1;
    if (sysArrayStart !== -1) {
      sysArrayEnd = findMatchingBracket(m, sysArrayStart + '"system":'.length);
    }
    const searchFrom = sysArrayStart !== -1 ? sysArrayStart : 0;
    const searchTo = sysArrayEnd !== -1 ? sysArrayEnd : m.length;

    let configStart = -1;
    let matchedMarker = '';
    for (const marker of IDENTITY_MARKERS) {
      const idx = m.indexOf(marker, searchFrom);
      if (idx !== -1 && idx < searchTo) {
        configStart = idx;
        matchedMarker = marker;
        break;
      }
    }

    if (configStart !== -1) {
      let stripFrom = configStart;
      if (stripFrom >= 2 && m[stripFrom - 2] === '\\' && m[stripFrom - 1] === 'n') {
        stripFrom -= 2;
      }

      let configEnd = -1;
      const searchAfter = configStart + matchedMarker.length;
      for (const pat of END_BOUNDARY_PATTERNS) {
        const idx = m.indexOf(pat, searchAfter);
        if (idx !== -1 && (configEnd === -1 || idx < configEnd)) {
          configEnd = idx;
        }
      }
      {
        const winPattern = /\\n## [A-Z]:\\\\/g;
        winPattern.lastIndex = searchAfter;
        const wm = winPattern.exec(m);
        if (wm !== null && (configEnd === -1 || wm.index < configEnd)) {
          configEnd = wm.index;
        }
      }

      if (configEnd !== -1) {
        const strippedLen = configEnd - stripFrom;
        if (strippedLen > 1000) {
          const PARAPHRASE =
            '\\nYou are an AI operations assistant with access to all tools listed in this request ' +
            'for file operations, command execution, web search, browser control, scheduling, ' +
            'messaging, and session management. Tool names are case-sensitive and must be called ' +
            'exactly as listed. Your responses route to the active channel automatically. ' +
            'For cross-session communication, use the task messaging tools. ' +
            'Skills defined in your workspace should be invoked when they match user requests. ' +
            'Consult your workspace reference files for detailed operational configuration.\\n';

          m = m.slice(0, stripFrom) + PARAPHRASE + m.slice(configEnd);
          logger.log(`[STRIP] Removed ${strippedLen} chars of config template (marker: "${matchedMarker}")`);
        }
      } else {
        logger.warn(`[STRIP] Layer 4: identity marker found ("${matchedMarker}") but no end boundary detected - skipping strip to preserve body integrity`);
      }
    }
  }

  if (transformConfig.stripToolDescriptions) {
    const toolsIdx = m.indexOf('"tools":[');
    if (toolsIdx !== -1) {
      const toolsEndIdx = findMatchingBracket(m, toolsIdx + '"tools":'.length);
      if (toolsEndIdx !== -1) {
        let section = m.slice(toolsIdx, toolsEndIdx + 1);
        let from = 0;
        while (true) {
          const d = section.indexOf('"description":"', from);
          if (d === -1) break;
          const vs = d + '"description":"'.length;
          let i = vs;
          while (i < section.length) {
            if (section[i] === '\\' && i + 1 < section.length) { i += 2; continue; }
            if (section[i] === '"') break;
            i++;
          }
          section = section.slice(0, vs) + section.slice(i);
          from = vs + 1;
        }
        if (transformConfig.injectCCStubs) {
          const insertAt = '"tools":['.length;
          section = section.slice(0, insertAt) + CC_TOOL_STUBS.join(',') + ',' + section.slice(insertAt);
        }
        m = m.slice(0, toolsIdx) + section + m.slice(toolsEndIdx + 1);
      }
    }
  } else if (transformConfig.injectCCStubs) {
    const toolsIdx = m.indexOf('"tools":[');
    if (toolsIdx !== -1) {
      const insertAt = toolsIdx + '"tools":['.length;
      m = m.slice(0, insertAt) + CC_TOOL_STUBS.join(',') + ',' + m.slice(insertAt);
    }
  }

  const BILLING_BLOCK = buildBillingBlock(m, originalFirstUserText);
  const sysArrayIdx = m.indexOf('"system":[');
  if (sysArrayIdx !== -1) {
    const insertAt = sysArrayIdx + '"system":['.length;
    m = m.slice(0, insertAt) + BILLING_BLOCK + ',' + m.slice(insertAt);
  } else if (m.includes('"system":"')) {
    const sysStart = m.indexOf('"system":"');
    let i = sysStart + '"system":"'.length;
    while (i < m.length) {
      if (m[i] === '\\') { i += 2; continue; }
      if (m[i] === '"') break;
      i++;
    }
    const sysEnd = i + 1;
    const originalSysStr = m.slice(sysStart + '"system":'.length, sysEnd);
    m = m.slice(0, sysStart)
      + '"system":[' + BILLING_BLOCK + ',{"type":"text","text":' + originalSysStr + '}]'
      + m.slice(sysEnd);
  } else {
    m = '{"system":[' + BILLING_BLOCK + '],' + m.slice(1);
  }

  const metaValue = JSON.stringify({ device_id: identity.deviceId, session_id: identity.sessionId });
  const metaJson = '"metadata":{"user_id":' + JSON.stringify(metaValue) + '}';
  const existingMeta = m.indexOf('"metadata":{');
  if (existingMeta !== -1) {
    let depth = 0, mi = existingMeta + '"metadata":'.length;
    for (; mi < m.length; mi++) {
      if (m[mi] === '{') depth++;
      else if (m[mi] === '}') { depth--; if (depth === 0) { mi++; break; } }
    }
    m = m.slice(0, existingMeta) + metaJson + m.slice(mi);
  } else {
    m = '{' + metaJson + ',' + m.slice(1);
  }

  if (transformConfig.stripTrailingAssistantPrefill !== false) {
    const msgsIdx = m.indexOf('"messages":[');
    if (msgsIdx !== -1) {
      const arrayStart = msgsIdx + '"messages":['.length;
      const positions = [];
      let depth = 0, inString = false, objStart = -1;
      for (let i = arrayStart; i < m.length; i++) {
        const c = m[i];
        if (inString) {
          if (c === '\\') { i++; continue; }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{') { if (depth === 0) objStart = i; depth++; }
        else if (c === '}') { depth--; if (depth === 0 && objStart !== -1) { positions.push({ start: objStart, end: i }); objStart = -1; } }
        else if (c === ']' && depth === 0) break;
      }
      let popped = 0;
      while (positions.length > 0) {
        const last = positions[positions.length - 1];
        const obj = m.slice(last.start, last.end + 1);
        if (!obj.includes('"role":"assistant"')) break;
        let stripFrom = last.start;
        for (let i = last.start - 1; i >= arrayStart; i--) {
          if (m[i] === ',') { stripFrom = i; break; }
          if (m[i] !== ' ' && m[i] !== '\n' && m[i] !== '\r' && m[i] !== '\t') break;
        }
        m = m.slice(0, stripFrom) + m.slice(last.end + 1);
        positions.pop();
        popped++;
      }
      if (popped > 0) {
        logger.log(`[STRIP-PREFILL] Removed ${popped} trailing assistant message(s)`);
      }
    }
  }

  return unmaskThinkingBlocks(unmaskOpaquePayloads(m, opaqueMasks), thinkMasks);
}

function reverseMap(text, config) {
  const transformConfig = normalizeTransformConfig(config || {});
  let r = text;
  for (const [orig, cc] of transformConfig.toolRenames) {
    r = r.split('"' + cc + '"').join('"' + orig + '"');
    r = r.split('\\"' + cc + '\\"').join('\\"' + orig + '\\"');
  }
  for (const [orig, renamed] of transformConfig.propRenames) {
    r = r.split('"' + renamed + '"').join('"' + orig + '"');
    r = r.split('\\"' + renamed + '\\"').join('\\"' + orig + '\\"');
  }
  for (const [sanitized, original] of transformConfig.reverseMap) {
    r = r.split(sanitized).join(original);
  }
  return r;
}

function transformJsonResponseBody(respBody, config) {
  const { masked: rMasked, masks: rMasks } = maskThinkingBlocks(respBody);
  return unmaskThinkingBlocks(reverseMap(rMasked, config), rMasks);
}

function transformErrorBody(errBody, config) {
  return reverseMap(errBody, config);
}

function createSseEventTransformer(config) {
  let currentBlockIsThinking = false;

  return function transformEvent(event) {
    let dataIdx = event.startsWith('data: ') ? 0 : event.indexOf('\ndata: ');
    if (dataIdx === -1) return reverseMap(event, config);
    if (dataIdx > 0) dataIdx += 1;
    const dataLineEnd = event.indexOf('\n', dataIdx + 6);
    const dataStr = dataLineEnd === -1
      ? event.slice(dataIdx + 6)
      : event.slice(dataIdx + 6, dataLineEnd);

    if (dataStr.indexOf('"type":"content_block_start"') !== -1) {
      if (dataStr.indexOf('"content_block":{"type":"thinking"') !== -1 ||
          dataStr.indexOf('"content_block":{"type":"redacted_thinking"') !== -1) {
        currentBlockIsThinking = true;
        return event;
      }
      currentBlockIsThinking = false;
      return reverseMap(event, config);
    }
    if (dataStr.indexOf('"type":"content_block_stop"') !== -1) {
      const wasThinking = currentBlockIsThinking;
      currentBlockIsThinking = false;
      return wasThinking ? event : reverseMap(event, config);
    }
    if (currentBlockIsThinking) {
      return event;
    }
    return reverseMap(event, config);
  };
}

function createSseStreamTransformer(config) {
  const decoder = new StringDecoder('utf8');
  const transformEvent = createSseEventTransformer(config);
  let pending = '';

  return {
    push(chunk) {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const events = [];
      let sepIdx;
      while ((sepIdx = pending.indexOf('\n\n')) !== -1) {
        const event = pending.slice(0, sepIdx + 2);
        pending = pending.slice(sepIdx + 2);
        events.push(transformEvent(event));
      }
      return events.join('');
    },
    end() {
      pending += decoder.end();
      const trailing = pending.length > 0 ? transformEvent(pending) : '';
      pending = '';
      return trailing;
    }
  };
}

module.exports = {
  createRuntimeIdentity,
  normalizeTransformConfig,
  getModelBetas,
  computeBillingFingerprint,
  extractFirstUserText,
  computeCch,
  buildBillingBlock,
  getStainlessHeaders,
  findMatchingBracket,
  findMatchingBrace,
  stripEffortFromObject,
  maskThinkingBlocks,
  unmaskThinkingBlocks,
  isLikelyBase64Payload,
  maskOpaquePayloads,
  unmaskOpaquePayloads,
  repairToolPairs,
  processBody,
  reverseMap,
  transformJsonResponseBody,
  transformErrorBody,
  createSseEventTransformer,
  createSseStreamTransformer
};
