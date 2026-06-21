'use strict';

const {
  DEFAULT_PROP_RENAMES,
  DEFAULT_REPLACEMENTS,
  DEFAULT_REVERSE_MAP,
  DEFAULT_TOOL_RENAMES
} = require('./constants');

// The Hermes rules were originally carried as the runtime template. Keep that
// template as the source for this extraction so the added Hermes mappings do
// not drift while we make sets first-class.
const HERMES_TEMPLATE = require('../config.runtime.example.json');

const COMPATIBILITY_SETS = {
  openclaw: {
    description: 'Legacy OpenClaw runtime compatibility rules.',
    replacements: DEFAULT_REPLACEMENTS,
    reverseMap: DEFAULT_REVERSE_MAP,
    toolRenames: DEFAULT_TOOL_RENAMES,
    propRenames: DEFAULT_PROP_RENAMES,
    options: {}
  },
  hermes: {
    description: 'Hermes Agent runtime compatibility rules.',
    replacements: HERMES_TEMPLATE.replacements || [],
    reverseMap: HERMES_TEMPLATE.reverseMap || [],
    toolRenames: HERMES_TEMPLATE.toolRenames || [],
    propRenames: HERMES_TEMPLATE.propRenames || [],
    options: {
      stripSystemConfig: HERMES_TEMPLATE.stripSystemConfig
    }
  }
};

function listCompatibilitySets() {
  return Object.keys(COMPATIBILITY_SETS);
}

function assertKnownCompatibilitySets(names) {
  for (const name of names) {
    if (!COMPATIBILITY_SETS[name]) {
      throw new Error('Unknown compatibility set "' + name + '". Available sets: ' + listCompatibilitySets().join(', '));
    }
  }
}

function mergePatternArrays(arrays) {
  const merged = new Map();
  for (const array of arrays) {
    for (const [find, replace] of (array || [])) {
      merged.set(find, replace);
    }
  }
  return [...merged.entries()];
}

function resolveCompatibilitySets(names) {
  const setNames = names || ['openclaw'];
  assertKnownCompatibilitySets(setNames);
  const sets = setNames.map((name) => COMPATIBILITY_SETS[name]);
  const options = {};
  for (const set of sets) {
    Object.assign(options, set.options || {});
  }
  return {
    names: setNames,
    options,
    replacements: mergePatternArrays(sets.map((set) => set.replacements)),
    reverseMap: mergePatternArrays(sets.map((set) => set.reverseMap)),
    toolRenames: mergePatternArrays(sets.map((set) => set.toolRenames)),
    propRenames: mergePatternArrays(sets.map((set) => set.propRenames))
  };
}

module.exports = {
  COMPATIBILITY_SETS,
  listCompatibilitySets,
  assertKnownCompatibilitySets,
  mergePatternArrays,
  resolveCompatibilitySets
};
