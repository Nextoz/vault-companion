import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  summarizeEvent,
  summarizeLine,
  sanitizeToken,
  validateHandoff,
  extractHandoff,
  main,
} from './worker-events.mjs';

const SECRET = 'PRIVATE-VAULT-TOKEN-7f3a';

describe('worker-events renderer', () => {
  it('renders only allow-listed metadata, never message text or tool payloads', () => {
    const cases = [
      [{ type: 'assistant_message', message: `${SECRET} in the response body` }, '[assistant] completed'],
      [{ type: 'item.completed', item: { type: 'function_call', name: 'Bash', arguments: `echo ${SECRET}` } }, '[tool] Bash'],
      [{ type: 'item.completed', item: { type: 'reasoning', summary: SECRET } }, '[reasoning] completed'],
      [{ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 34 } }, '[turn] tokens in=12 out=34'],
      [{ type: 'error', error: { type: 'quota_error', message: SECRET } }, '[error] quota_error'],
      [{ type: 'exit', reason: 'completed' }, '[exit] completed'],
    ];
    for (const [event, expected] of cases) {
      const summary = summarizeEvent(event);
      expect(summary).toBe(expected);
      expect(summary).not.toContain(SECRET);
    }
  });

  it('sanitizes arbitrary tokens and refuses non-token content', () => {
    expect(sanitizeToken('ok-name_1.2')).toBe('ok-name_1.2');
    expect(sanitizeToken(`echo ${SECRET}`)).toBe('…');
    expect(sanitizeToken('')).toBe('…');
  });

  it('preserves malformed lines and never echoes their raw bytes', () => {
    const line = `{"type":"error","message":"${SECRET}"`;
    const result = summarizeLine(line);
    expect(result.malformed).toBe(true);
    expect(result.summary).toContain('saved');
    expect(result.summary).not.toContain(SECRET);
    const good = summarizeLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(good.malformed).toBe(false);
    expect(good.summary).toBe('[turn] tokens in=1 out=2');
  });

  it('extracts a structured public-only handoff from an item.completed message', () => {
    const handoff = { version: 1, completed: ['fixed thing'], verification: [{ check: 'tsc', result: 'passed' }] };
    const event = { type: 'item.completed', item: { type: 'message', content: JSON.stringify(handoff) } };
    expect(extractHandoff(event)).toEqual(handoff);
    expect(extractHandoff({ type: 'item.completed', item: { type: 'message', content: 'not json' } })).toBeNull();
    expect(extractHandoff({ type: 'item.completed', item: { type: 'function_call', content: JSON.stringify(handoff) } })).toBeNull();
  });

  it('supports actual Codex 0.159.2 agent_message, command_execution and usage shapes', () => {
    const session = '01a0f0ab-0000-7000-8000-000000000001';
    expect(summarizeEvent({ type: 'thread.started', thread_id: session })).toBe(`[session] ${session}`);
    expect(summarizeEvent({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } })).toBe('[turn] tokens in=3 out=4');
    expect(summarizeEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'ready' } })).toBe('[agent] completed');
    expect(summarizeEvent({ type: 'item.completed', item: { type: 'command_execution', command: `echo ${SECRET}` } })).toBe('[command] completed');
    const handoff = { version: 1, completed: ['done'], verification: [{ check: 'tsc', result: 'passed' }] };
    const agentHandoff = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(handoff) } };
    expect(extractHandoff(agentHandoff)).toEqual(handoff);
  });

  it('renders only known metadata categories, never free-form token-like fields', () => {
    expect(summarizeEvent({ type: 'error', error: { type: SECRET, message: 'bad' } })).toBe('[error] error');
    expect(summarizeEvent({ type: 'item.completed', item: { type: 'function_call', name: SECRET } })).toBe('[tool] tool');
    expect(summarizeEvent({ type: 'thread.started', thread_id: SECRET })).toBe('[session] started');
    expect(summarizeEvent({ type: 'exit', reason: SECRET })).toBe('[exit]');
  });

  it('validates handoff shape and strips unknown fields', () => {
    expect(validateHandoff(null).valid).toBe(false);
    expect(validateHandoff({ version: 1, completed: [], verification: [] }).valid).toBe(true);
    const checked = validateHandoff({
      version: 1,
      completed: ['a'],
      verification: [{ check: 'c', result: 'passed' }],
      notes: SECRET,
    });
    expect(checked.valid).toBe(true);
    expect(checked.value).not.toHaveProperty('notes');
    expect(validateHandoff({ version: 1, completed: 'x', verification: [] }).valid).toBe(false);
    expect(validateHandoff({ version: 1, completed: [], verification: [{ check: 'c', result: 'maybe' }] }).valid).toBe(false);
  });
});

describe('worker-events CLI', () => {
  it('appends raw evidence (including malformed lines) and renders sanitized summaries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-events-'));
    const eventsFile = path.join(dir, 'events.jsonl');
    const handoffFile = path.join(dir, 'handoff.json');
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: '01a0f0ab-0000-7000-8000-000000000001' }),
      `{"type":"error","message":"${SECRET}"`,
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'message', content: JSON.stringify({ version: 1, completed: ['done'], verification: [{ check: 'tsc', result: 'passed' }] }) } }),
    ];
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([eventsFile, handoffFile], {
      stdin: Readable.from(lines),
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: (chunk: string) => err.push(chunk) },
    });

    expect(code).toBe(0);
    const raw = fs.readFileSync(eventsFile, 'utf8');
    for (const line of lines) expect(raw).toContain(line);
    expect(raw).toContain(SECRET); // evidence is preserved on disk, just never rendered
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.join('\n')).toContain('[session]');
    expect(err.join('\n')).toContain('malformed');
    const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
    expect(handoff.version).toBe(1);
    expect(handoff.completed).toEqual(['done']);
  });

  it('buffers UTF-8 across byte boundaries and flushes an EOF tail without a newline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-events-boundary-'));
    const eventsFile = path.join(dir, 'events.jsonl');
    const handoffFile = path.join(dir, 'handoff.json');
    const first = JSON.stringify({ type: 'thread.started', thread_id: '01a0f0ab-0000-7000-8000-000000000001' });
    const second = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 }, note: '✓ boundary' });
    const text = `${first}\n${second}`;
    const bytes = Buffer.from(text, 'utf8');
    const split = Math.floor(bytes.length / 2);
    const out: string[] = [];
    const code = await main([eventsFile, handoffFile], {
      stdin: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
      stdout: { write: (chunk: string) => out.push(chunk) },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(eventsFile, 'utf8')).toContain(second);
    expect(out.join('\n')).toContain('[turn] tokens in=2 out=3');
  });

  it('runs through the actual CLI with Buffer input and preserves evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-events-cli-'));
    const eventsFile = path.join(dir, 'events.jsonl');
    const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 5 } });
    const result = spawnSync(process.execPath, ['tools/worker-events.mjs', eventsFile], {
      input: Buffer.from(`${line}\n`, 'utf8'),
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(eventsFile, 'utf8')).toContain(line);
    expect(result.stdout).toContain('[turn] tokens in=4 out=5');
  });
});
