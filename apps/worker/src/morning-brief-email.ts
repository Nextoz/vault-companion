// Morning Brief email (MB1d): a pure renderer for the committed brief JSON plus a thin wrapper over the Cloudflare
// `send_email` binding. No I/O and no Worker imports here, so the renderer is golden-diffable. The HTML escapes every
// interpolated string; a fallback brief renders exactly what it contains and invents nothing.

import type { BriefFile } from '@vault-companion/domain';
import { briefMeetingRows, briefTodoAge, briefUnavailableLines } from '@vault-companion/contracts';

/** One rendered message: a plain-text and an HTML body for the same subject. */
export interface BriefEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Sends one already-rendered message. Production is the `send_email` binding; tests use a spy. */
export interface BriefMailer {
  send(message: BriefEmail): Promise<void>;
}

/**
 * The Workers `send_email` binding (Email Routing: free, verified destination only). It takes an `EmailMessage`
 * built from raw MIME; the repo installs no `@cloudflare/workers-types`, so the shape is declared structurally.
 */
export interface BriefEmailBinding {
  send(message: unknown): Promise<unknown>;
}

/** Builds the runtime `EmailMessage` (`new EmailMessage(from, to, raw)` from `cloudflare:email`; injected by index.ts). */
export type EmailMessageFactory = (from: string, to: string, raw: string) => unknown;

function b64(value: string): string {
  let bin = '';
  for (const byte of new TextEncoder().encode(value)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function b64Lines(value: string): string {
  return (b64(value).match(/.{1,76}/g) ?? ['']).join('\r\n');
}

/** RFC 5322 multipart/alternative message; subject and bodies are base64 UTF-8, so any brief text is header-safe. */
export function buildMime(from: string, to: string, message: BriefEmail, messageId: string): string {
  const boundary = `vc-${messageId}`;
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64Lines(body)].join('\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(message.subject)}?=`,
    `Message-ID: <${messageId}@vault-companion>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    part('text/plain', message.text),
    part('text/html', message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Wrap the `send_email` binding with the owner's fixed from/to addresses (both are secrets, never logged). */
export function cloudflareMailer(binding: BriefEmailBinding, from: string, to: string, create: EmailMessageFactory): BriefMailer {
  return {
    async send(message) {
      await binding.send(await create(from, to, buildMime(from, to, message, crypto.randomUUID())));
    },
  };
}

/** Escape `& < > " '` so no brief text can open a tag or attribute in the HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Pure render of the committed brief: subject plus a text and an HTML body with every interpolation escaped. */
export function renderBriefEmail(file: BriefFile): BriefEmail {
  const { brief } = file;
  const subject = `Morning Brief - ${file.date}`;
  const unavailable = briefUnavailableLines(file);
  const meetings = briefMeetingRows(file);
  const gaps = file.unavailable.includes('calendar') ? [] : brief.gaps;

  const text: string[] = [brief.dayLine];
  if (brief.stateLine !== undefined) text.push(`State: ${brief.stateLine}`);
  text.push('', 'Today');
  for (const meeting of meetings) {
    text.push(meeting.text);
    if (meeting.clash) text.push(meeting.clash);
    if (meeting.link) text.push(`Open in Calendar: ${meeting.link}`);
  }
  text.push('', 'Free blocks:');
  if (gaps.length === 0) {
    text.push('- none');
  } else {
    for (const gap of gaps) {
      const suggestion = gap.suggestion !== undefined ? `: ${gap.suggestion}` : '';
      text.push(`- ${gap.start} - ${gap.end}${suggestion}`);
    }
  }
  text.push('', 'Todos:');
  if (brief.todos.length === 0) {
    text.push('- none');
  } else {
    for (const todo of brief.todos.slice(0, 5)) {
      const due = todo.due !== null ? ` (due ${todo.due})` : '';
      text.push(`- ${todo.text}${briefTodoAge(todo)}${due}`);
      if (todo.firstStep !== undefined) text.push(`  First step: ${todo.firstStep}`);
    }
  }
  if (brief.encouragement !== undefined) text.push('', brief.encouragement);
  text.push('', ...unavailable);

  const html: string[] = [`<h1>Morning Brief - ${escapeHtml(file.date)}</h1>`, `<p>${escapeHtml(brief.dayLine)}</p>`];
  if (brief.stateLine !== undefined) html.push(`<p>State: ${escapeHtml(brief.stateLine)}</p>`);
  html.push('<h2>Today</h2>');
  for (const meeting of meetings) {
    html.push(`<p>${escapeHtml(meeting.text)}${meeting.clash ? `<br>${escapeHtml(meeting.clash)}` : ''}${meeting.link ? `<br><a href="${escapeHtml(meeting.link)}" target="_blank" rel="noopener noreferrer">Open in Calendar</a>` : ''}</p>`);
  }
  html.push('<h2>Free blocks</h2>');
  if (gaps.length === 0) {
    html.push('<p>none</p>');
  } else {
    html.push('<ul>');
    for (const gap of gaps) {
      const suggestion = gap.suggestion !== undefined ? `: ${escapeHtml(gap.suggestion)}` : '';
      html.push(`<li>${escapeHtml(gap.start)} - ${escapeHtml(gap.end)}${suggestion}</li>`);
    }
    html.push('</ul>');
  }
  html.push('<h2>Todos</h2>');
  if (brief.todos.length === 0) {
    html.push('<p>none</p>');
  } else {
    html.push('<ul>');
    for (const todo of brief.todos.slice(0, 5)) {
      const due = todo.due !== null ? ` (due ${escapeHtml(todo.due)})` : '';
      const firstStep = todo.firstStep !== undefined ? `<br>First step: ${escapeHtml(todo.firstStep)}` : '';
      html.push(`<li>${escapeHtml(todo.text)}${briefTodoAge(todo)}${due}${firstStep}</li>`);
    }
    html.push('</ul>');
  }
  if (brief.encouragement !== undefined) html.push(`<p>${escapeHtml(brief.encouragement)}</p>`);
  html.push(...unavailable.map((line) => `<p>${escapeHtml(line)}</p>`));

  return { subject, text: text.join('\n'), html: html.join('\n') };
}
