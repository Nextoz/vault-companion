#!/usr/bin/env node
// Codex `--json` event stream processor.
//
// Reads JSON Lines events from stdin, appends every raw line verbatim to an evidence file
// (malformed lines are preserved, never discarded), and prints only sanitized metadata
// summaries to stdout for the visible pane. It never echoes message text, tool arguments,
// commands, reasoning content, secrets, or full raw JSON.
//
// Usage: node tools/worker-events.mjs <events.jsonl> [<handoff.json>]

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,80}$/u;
const REDACTED = '…';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ERROR_CATEGORIES = new Set([
  'quota_error', 'insufficient_quota', 'rate_limit', 'usage_limit', 'billing', 'provider_error',
  'model_not_found', 'invalid_api_key', 'invalid_request', 'network_error', 'timeout', 'tool_error',
  'check_failed', 'verification-error', 'mcp_error', 'sandbox_error', 'permission_denied', 'credential_error',
]);
const ITEM_KINDS = new Set(['agent_message', 'message', 'reasoning', 'function_call', 'command_execution', 'tool_use']);
const TOOL_NAMES = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit', 'ApplyPatch']);
const EXIT_REASONS = new Set(['completed', 'interrupted', 'timeout', 'error', 'aborted']);

// Only ever return a very small allow-listed token. Arbitrary content can never pass through.
export function sanitizeToken(value) {
  if (typeof value !== 'string') return REDACTED;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || !TOKEN_RE.test(trimmed)) return REDACTED;
  return trimmed;
}

// Only structurally valid opaque IDs may be rendered; arbitrary token-like text is refused.
export function isValidId(value) {
  return typeof value === 'string' && ID_RE.test(value.trim());
}

function known(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function stringField(event, key) {
  const value = event?.[key];
  return typeof value === 'string' ? value : null;
}

export function errorCategory(event) {
  const err = event?.error;
  if (err && typeof err === 'object') {
    for (const key of ['type', 'code']) {
      const category = known(err[key], ERROR_CATEGORIES);
      if (category) return category;
    }
  }
  return known(stringField(event, 'code'), ERROR_CATEGORIES) ?? 'error';
}

// Turn a single parsed event into a display line, or null when there is nothing safe to show.
export function summarizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = stringField(event, 'type');
  const item = event.item && typeof event.item === 'object' ? event.item : null;
  const itemType = item ? stringField(item, 'type') : null;
  const session = stringField(event, 'thread_id') ?? stringField(event, 'session_id');
  const turn = stringField(event, 'turn_id');

  if (type === 'thread.started') return isValidId(session) ? `[session] ${session}` : '[session] started';
  if (type === 'turn.started') return isValidId(turn) ? `[turn] ${turn}` : '[turn] started';
  if (type === 'turn.completed') {
    const usage = event.usage && typeof event.usage === 'object' ? event.usage : null;
    const input = Number.isSafeInteger(usage?.input_tokens) ? String(usage.input_tokens) : '?';
    const output = Number.isSafeInteger(usage?.output_tokens) ? String(usage.output_tokens) : '?';
    return `[turn] tokens in=${input} out=${output}`;
  }
  if (type === 'item.started') {
    if (itemType === 'function_call') {
      const name = stringField(item, 'name') ?? stringField(item, 'tool_name');
      return `[tool] ${known(name, TOOL_NAMES) ?? 'tool'} starting`;
    }
    if (itemType === 'command_execution') return '[command] started';
    return `[${known(itemType, ITEM_KINDS) ?? 'item'}] started`;
  }
  if (type === 'item.completed') {
    if (itemType === 'function_call') {
      const name = stringField(item, 'name') ?? stringField(item, 'tool_name');
      return `[tool] ${known(name, TOOL_NAMES) ?? 'tool'}`;
    }
    if (itemType === 'command_execution') return '[command] completed';
    if (itemType === 'reasoning') return '[reasoning] completed';
    if (itemType === 'message') return '[assistant] completed';
    if (itemType === 'agent_message') return '[agent] completed';
    return `[${known(itemType, ITEM_KINDS) ?? 'item'}] completed`;
  }
  if (type === 'assistant_message') return '[assistant] completed';
  if (type === 'user_message') return '[user] prompt sent';
  if (type === 'error') return `[error] ${errorCategory(event)}`;
  if (type === 'exit') {
    const reason = stringField(event, 'reason');
    return known(reason, EXIT_REASONS) ? `[exit] ${reason}` : '[exit]';
  }
  return null;
}

const DISPOSITIONS = new Set(['fix-now', 'follow-up', 'leave-alone']);
const RESULTS = new Set(['passed', 'failed', 'not-run']);

// Validate the public-only handoff shape and return a copy containing only allowed fields.
// Returns { valid, value } — value is null when the input is not a conforming handoff.
export function validateHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, value: null };
  if (value.version !== 1 || !Array.isArray(value.completed) || !Array.isArray(value.verification)) {
    return { valid: false, value: null };
  }
  const clean = { version: 1, completed: [], verification: [] };
  if (value.completed.length > 20) return { valid: false, value: null };
  for (const entry of value.completed) {
    if (typeof entry !== 'string' || entry.length > 500) return { valid: false, value: null };
    clean.completed.push(entry);
  }
  if (value.discoveries !== undefined) {
    if (!Array.isArray(value.discoveries) || value.discoveries.length > 20) return { valid: false, value: null };
    clean.discoveries = [];
    for (const d of value.discoveries) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) return { valid: false, value: null };
      if (typeof d.finding !== 'string' || d.finding.length > 500 || !DISPOSITIONS.has(d.disposition)) {
        return { valid: false, value: null };
      }
      clean.discoveries.push({ finding: d.finding, disposition: d.disposition });
    }
  }
  if (value.verification.length > 30) return { valid: false, value: null };
  for (const v of value.verification) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { valid: false, value: null };
    if (typeof v.check !== 'string' || v.check.length > 200 || !RESULTS.has(v.result)) {
      return { valid: false, value: null };
    }
    clean.verification.push({ check: v.check, result: v.result });
  }
  if (value.unsupported !== undefined) {
    if (!Array.isArray(value.unsupported) || value.unsupported.length > 10) return { valid: false, value: null };
    clean.unsupported = [];
    for (const u of value.unsupported) {
      if (typeof u !== 'string' || u.length > 200) return { valid: false, value: null };
      clean.unsupported.push(u);
    }
  }
  return { valid: true, value: clean };
}

// The structured handoff produced by `--output-schema` arrives as a message item whose
// content is a JSON object shaped like a handoff.
export function extractHandoff(event) {
  if (!event || typeof event !== 'object' || stringField(event, 'type') !== 'item.completed') return null;
  const item = event.item;
  if (!item || typeof item !== 'object') return null;
  const content = item.type === 'message' ? item.content : item.type === 'agent_message' ? item.text : null;
  if (typeof content !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  const checked = validateHandoff(parsed);
  return checked.valid ? checked.value : null;
}

// Process one raw JSONL line. Returns { malformed, summary, event, handoff }.
export function summarizeLine(line) {
  const text = line.trim();
  if (!text) return { malformed: false, summary: null, event: null, handoff: null };
  let event;
  try { event = JSON.parse(text); } catch {
    return { malformed: true, summary: `[events] malformed event (${line.length} bytes) saved`, event: null, handoff: null };
  }
  return {
    malformed: false,
    summary: summarizeEvent(event),
    event,
    handoff: extractHandoff(event),
  };
}

export function usage() {
  return 'usage: node tools/worker-events.mjs <events.jsonl> [<handoff.json>]';
}

function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    push(chunk) {
      if (typeof chunk === 'string') {
        const parts = chunk.split(/\r\n|\n|\r/u);
        for (let i = 0; i < parts.length; i += 1) {
          const part = parts[i];
          if (i === parts.length - 1 && part === '') break;
          onLine(part);
        }
        return;
      }
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? ''));
      pending += text;
      const parts = pending.split(/\r\n|\n|\r/u);
      pending = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    end() {
      const tail = pending + decoder.end();
      pending = '';
      if (tail.length > 0) onLine(tail);
    },
  };
}

// Testable CLI. Streams default to process.* when not injected.
export async function main(argv, streams = {}) {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  if (argv.length < 1) { stderr.write(`${usage()}\n`); return 2; }
  const eventsFile = path.resolve(argv[0]);
  const handoffFile = argv[1] ? path.resolve(argv[1]) : null;

  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  let saved = 0;
  let malformed = 0;
  let sessionId = null;
  let tokens = null;

  const reader = createLineReader(raw => {
    fs.appendFileSync(eventsFile, `${raw}\n`);
    saved += 1;
    const result = summarizeLine(raw);
    if (result.malformed) {
      malformed += 1;
      stdout.write(`${result.summary}\n`);
      return;
    }
    const event = result.event;
    if (!sessionId) sessionId = stringField(event, 'thread_id') ?? stringField(event, 'session_id');
    const usage = event?.usage;
    if (usage && Number.isSafeInteger(usage.output_tokens) && Number.isSafeInteger(usage.input_tokens)) {
      tokens = (tokens ?? 0) + usage.input_tokens + usage.output_tokens;
    }
    if (result.summary) stdout.write(`${result.summary}\n`);
    if (result.handoff && handoffFile) {
      fs.writeFileSync(handoffFile, `${JSON.stringify(result.handoff, null, 2)}\n`);
      stdout.write('[handoff] structured handoff saved\n');
    }
  });
  for await (const chunk of stdin) {
    reader.push(chunk);
  }
  reader.end();
  if (isValidId(sessionId)) stdout.write(`[session] ${sessionId}\n`);
  if (tokens !== null) stdout.write(`[tokens] ${tokens}\n`);
  if (malformed) stderr.write(`[events] ${malformed} malformed event(s) preserved in ${eventsFile}\n`);
  return saved > 0 ? 0 : 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
