'use strict';

const DEFAULT_PORT = 18801;
const UPSTREAM_HOST = 'api.anthropic.com';
const VERSION = '2.2.3';

// Claude Code version to emulate (update when new CC versions are released)
const CC_VERSION = '2.1.97';

// Billing fingerprint constants (matches real CC utils/fingerprint.ts)
const BILLING_HASH_SALT = '59cf53e54c78';
const BILLING_HASH_INDICES = [4, 7, 20];

// Beta flags required for OAuth + Claude Code features
const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'context-management-2025-06-27'
];

const OAUTH_TOKEN_URL = 'https://claude.ai/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// CC tool stubs -- injected into tools array to make the tool set look more
// like a Claude Code session. The model won't call these (schemas are minimal).
const CC_TOOL_STUBS = [
  '{"name":"mcp_Glob","description":"Find files by pattern","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}',
  '{"name":"mcp_Grep","description":"Search file contents","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern"},"path":{"type":"string","description":"Search path"}},"required":["pattern"]}}',
  '{"name":"mcp_Agent","description":"Launch a subagent for complex tasks","input_schema":{"type":"object","properties":{"prompt":{"type":"string","description":"Task description"}},"required":["prompt"]}}',
  '{"name":"mcp_NotebookEdit","description":"Edit notebook cells","input_schema":{"type":"object","properties":{"notebook_path":{"type":"string"},"cell_index":{"type":"integer"}},"required":["notebook_path"]}}',
  '{"name":"mcp_TodoRead","description":"Read current task list","input_schema":{"type":"object","properties":{}}}'
];

// Applied globally via split/join on the entire request body.
// IMPORTANT: Use space-free replacements for lowercase 'openclaw' to avoid
// breaking filesystem paths (e.g., .openclaw/ -> .ocplatform/, not .oc platform/)
const DEFAULT_REPLACEMENTS = [
  ['OpenClaw', 'OCPlatform'],
  ['openclaw', 'ocplatform'],
  ['sessions_spawn', 'create_task'],
  ['sessions_list', 'list_tasks'],
  ['sessions_history', 'get_history'],
  ['sessions_send', 'send_to_task'],
  ['sessions_yield_interrupt', 'task_yield_interrupt'],
  ['sessions_yield', 'yield_task'],
  ['sessions_store', 'task_store'],
  ['HEARTBEAT_OK', 'HB_ACK'],
  ['HEARTBEAT', 'HB_SIGNAL'],
  ['heartbeat', 'hb_signal'],
  ['running inside', 'operating from'],
  ['Prometheus', 'PAssistant'],
  ['prometheus', 'passistant'],
  ['clawhub.com', 'skillhub.example.com'],
  ['clawhub', 'skillhub'],
  ['clawd', 'agentd'],
  ['lossless-claw', 'lossless-ctx'],
  ['third-party', 'external'],
  ['billing proxy', 'routing layer'],
  ['billing-proxy', 'routing-layer'],
  ['x-anthropic-billing-header', 'x-routing-config'],
  ['x-anthropic-billing', 'x-routing-cfg'],
  ['cc_version', 'rt_version'],
  ['cc_entrypoint', 'rt_entrypoint'],
  ['billing header', 'routing config'],
  ['extra usage', 'usage quota'],
  ['assistant platform', 'ocplatform']
];

// Tool name renames are applied as "quoted" replacements throughout the entire
// body. ORDERING: lcm_expand_query MUST come before lcm_expand to avoid partial match.
const DEFAULT_TOOL_RENAMES = [
  ['exec', 'mcp_Bash'],
  ['process', 'mcp_BashSession'],
  ['browser', 'mcp_BrowserControl'],
  ['canvas', 'mcp_CanvasView'],
  ['nodes', 'mcp_DeviceControl'],
  ['cron', 'mcp_Scheduler'],
  ['message', 'mcp_SendMessage'],
  ['tts', 'mcp_Speech'],
  ['gateway', 'mcp_SystemCtl'],
  ['agents_list', 'mcp_AgentList'],
  ['list_tasks', 'mcp_TaskList'],
  ['get_history', 'mcp_TaskHistory'],
  ['send_to_task', 'mcp_TaskSend'],
  ['create_task', 'mcp_TaskCreate'],
  ['subagents', 'mcp_AgentControl'],
  ['session_status', 'mcp_StatusCheck'],
  ['web_search', 'mcp_WebSearch'],
  ['web_fetch', 'mcp_WebFetch'],
  // NOTE: ['image', 'ImageGen'] removed — collides with Anthropic content block type "image".
  ['pdf', 'mcp_PdfParse'],
  ['image_generate', 'mcp_ImageCreate'],
  ['music_generate', 'mcp_MusicCreate'],
  ['video_generate', 'mcp_VideoCreate'],
  ['memory_search', 'mcp_KnowledgeSearch'],
  ['memory_get', 'mcp_KnowledgeGet'],
  ['lcm_expand_query', 'mcp_ContextQuery'],
  ['lcm_grep', 'mcp_ContextGrep'],
  ['lcm_describe', 'mcp_ContextDescribe'],
  ['lcm_expand', 'mcp_ContextExpand'],
  ['yield_task', 'mcp_TaskYield'],
  ['task_store', 'mcp_TaskStore'],
  ['task_yield_interrupt', 'mcp_TaskYieldInterrupt']
];

const DEFAULT_PROP_RENAMES = [
  ['session_id', 'thread_id'],
  ['conversation_id', 'thread_ref'],
  ['summaryIds', 'chunk_ids'],
  ['summary_id', 'chunk_id'],
  ['system_event', 'event_text'],
  ['agent_id', 'worker_id'],
  ['wake_at', 'trigger_at'],
  ['wake_event', 'trigger_event']
];

const DEFAULT_REVERSE_MAP = [
  ['OCPlatform', 'OpenClaw'],
  ['ocplatform', 'openclaw'],
  ['create_task', 'sessions_spawn'],
  ['list_tasks', 'sessions_list'],
  ['get_history', 'sessions_history'],
  ['send_to_task', 'sessions_send'],
  ['task_yield_interrupt', 'sessions_yield_interrupt'],
  ['yield_task', 'sessions_yield'],
  ['task_store', 'sessions_store'],
  ['HB_ACK', 'HEARTBEAT_OK'],
  ['HB_SIGNAL', 'HEARTBEAT'],
  ['hb_signal', 'heartbeat'],
  ['PAssistant', 'Prometheus'],
  ['passistant', 'prometheus'],
  ['skillhub.example.com', 'clawhub.com'],
  ['skillhub', 'clawhub'],
  ['agentd', 'clawd'],
  ['lossless-ctx', 'lossless-claw'],
  ['external', 'third-party'],
  ['routing layer', 'billing proxy'],
  ['routing-layer', 'billing-proxy'],
  ['x-routing-config', 'x-anthropic-billing-header'],
  ['x-routing-cfg', 'x-anthropic-billing'],
  ['rt_version', 'cc_version'],
  ['rt_entrypoint', 'cc_entrypoint'],
  ['routing config', 'billing header'],
  ['usage quota', 'extra usage']
];

module.exports = {
  DEFAULT_PORT,
  UPSTREAM_HOST,
  VERSION,
  CC_VERSION,
  BILLING_HASH_SALT,
  BILLING_HASH_INDICES,
  REQUIRED_BETAS,
  OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID,
  CC_TOOL_STUBS,
  DEFAULT_REPLACEMENTS,
  DEFAULT_TOOL_RENAMES,
  DEFAULT_PROP_RENAMES,
  DEFAULT_REVERSE_MAP
};
