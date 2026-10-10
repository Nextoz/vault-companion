// Morning Brief email (MB1d): a pure renderer for the committed brief JSON plus a thin wrapper over the Cloudflare
// `send_email` binding. No I/O and no Worker imports here, so the renderer is golden-diffable. The HTML escapes every
// interpolated string; a fallback brief renders exactly what it contains and invents nothing.

import type { BriefFile } from '@vault-companion/domain';
import { briefCopenhagen, briefDigestUnavailable, briefNeedsYou, briefNews, briefOneThing, briefResearch, briefTimeline, briefTodoAge, briefUnavailableLines } from '@vault-companion/contracts';

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
export function renderBriefEmail(file: BriefFile, now: Date = new Date()): BriefEmail {
  const { brief } = file;
  const subject = `Morning Brief - ${file.date}`;
  const unavailable = briefUnavailableLines(file);
  // MB4: the email and the phone sheet share `briefTimeline`, so both show the same rows in the same order.
  const timeline = briefTimeline(file, now);
  const needsYou = briefNeedsYou(file);
  const copenhagen = briefCopenhagen(file);
  const news = briefNews(file);
  const research = briefResearch(file);
  const oneThing = briefOneThing(file);
  const digestUnavailable = briefDigestUnavailable(file);
  const noMeetings = !timeline.calendarFailed && timeline.allDay.length === 0 && timeline.rows.every((row) => row.kind !== 'meeting');

  const text: string[] = [brief.dayLine];
  if (brief.stateLine !== undefined) text.push(`State: ${brief.stateLine}`);
  if (unavailable.length > 0) text.push('', ...unavailable);
  if (timeline.allDay.length > 0) text.push('', `All day: ${timeline.allDay.join(', ')}`);
  if (!timeline.calendarFailed) {
    text.push('', 'Today');
    if (noMeetings) text.push('No meetings today');
    for (const row of timeline.rows) {
      text.push(`${row.time}  ${row.label}`);
      if (row.clashBadge !== null && row.overlap !== null) text.push(`  ${row.clashBadge}: ${row.overlap}`);
      if (row.link !== null) text.push(`  Open in Calendar: ${row.link}`);
    }
  }
  text.push('', 'Also today');
  if (brief.todos.length === 0) {
    text.push('- none');
  } else {
    for (const todo of brief.todos.slice(0, 5)) {
      const due = todo.due !== null ? ` (due ${todo.due})` : '';
      text.push(`- ${todo.text}${briefTodoAge(todo)}${due}`);
      if (todo.firstStep !== undefined) text.push(`  First step: ${todo.firstStep}`);
    }
  }
  if (digestUnavailable !== null) {
    text.push('', `News unavailable: ${digestUnavailable}`, `AI and research unavailable: ${digestUnavailable}`);
  } else {
    if (needsYou.length > 0) {
      text.push('', 'Needs you');
      for (const item of needsYou) text.push(`- ${item.title} - ${item.line} (${item.url})`);
    }
    if (copenhagen.length > 0) {
      text.push('', 'Copenhagen today');
      for (const item of copenhagen) text.push(`- ${item.title} - ${item.line} (${item.url})`);
    }
    if (news.length > 0) {
      text.push('', 'News');
      for (const item of news) text.push(`- ${item.title} - ${item.line} (${item.url})`);
    }
    if (research.length > 0) {
      text.push('', 'AI and research');
      for (const item of research) text.push(`- ${item.title} - ${item.line} (${item.url})`);
    }
  }
  if (oneThing !== null) {
    text.push('', oneThing.text);
    if (oneThing.quote !== undefined) text.push(`> ${oneThing.quote}`);
  } else if (brief.encouragement !== undefined) text.push('', brief.encouragement);
  text.push('', ...unavailable);

  const html: string[] = [`<h1>Morning Brief - ${escapeHtml(file.date)}</h1>`, `<p>${escapeHtml(brief.dayLine)}</p>`];
  if (brief.stateLine !== undefined) html.push(`<p>State: ${escapeHtml(brief.stateLine)}</p>`);
  html.push(...unavailable.map((line) => `<p class="morning-brief-unavailable">${escapeHtml(line)}</p>`));
  if (timeline.allDay.length > 0) html.push(`<p>All day: ${escapeHtml(timeline.allDay.join(', '))}</p>`);
  if (!timeline.calendarFailed) {
    html.push('<h2>Today</h2>');
    if (noMeetings) html.push('<p>No meetings today</p>');
    if (timeline.rows.length > 0) {
      html.push('<ol class="morning-brief-timeline">');
      for (const row of timeline.rows) {
        const clash = row.clashBadge !== null && row.overlap !== null ? ` <span class="morning-brief-clash">${escapeHtml(row.clashBadge)} - ${escapeHtml(row.overlap)}</span>` : '';
        const link = row.link !== null ? ` <a href="${escapeHtml(row.link)}" target="_blank" rel="noopener noreferrer">Open in Calendar</a>` : '';
        html.push(`<li><span class="morning-brief-time">${escapeHtml(row.time)}</span> <span class="morning-brief-row-label">${escapeHtml(row.label)}</span>${clash}${link}</li>`);
      }
      html.push('</ol>');
    }
  }
  html.push('<h2>Also today</h2>');
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
  if (digestUnavailable !== null) {
    html.push(`<p>${escapeHtml(`News unavailable: ${digestUnavailable}`)}</p>`, `<p>${escapeHtml(`AI and research unavailable: ${digestUnavailable}`)}</p>`);
  } else {
    if (needsYou.length > 0) {
      html.push('<h2>Needs you</h2>', '<ul>');
      for (const item of needsYou) html.push(`<li>${escapeHtml(item.title)} - ${escapeHtml(item.line)} <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Link</a></li>`);
      html.push('</ul>');
    }
    if (copenhagen.length > 0) {
      html.push('<h2>Copenhagen today</h2>', '<ul>');
      for (const item of copenhagen) html.push(`<li>${escapeHtml(item.title)} - ${escapeHtml(item.line)} <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Link</a></li>`);
      html.push('</ul>');
    }
    if (news.length > 0) {
      html.push('<h2>News</h2>', '<ul>');
      for (const item of news) html.push(`<li>${escapeHtml(item.title)} - ${escapeHtml(item.line)} <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Link</a></li>`);
      html.push('</ul>');
    }
    if (research.length > 0) {
      html.push('<h2>AI and research</h2>', '<ul>');
      for (const item of research) html.push(`<li>${escapeHtml(item.title)} - ${escapeHtml(item.line)} <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Link</a></li>`);
      html.push('</ul>');
    }
  }
  if (oneThing !== null) {
    html.push(`<p>${escapeHtml(oneThing.text)}</p>`);
    if (oneThing.quote !== undefined) html.push(`<blockquote>${escapeHtml(oneThing.quote)}</blockquote>`);
  } else if (brief.encouragement !== undefined) html.push(`<p>${escapeHtml(brief.encouragement)}</p>`);

  return { subject, text: text.join('\n'), html: html.join('\n') };
}
