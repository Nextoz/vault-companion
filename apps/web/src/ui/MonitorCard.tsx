// S0: the shared disclosure card for Boards monitors (AI usage today, more tomorrow). One component owns the head
// button, the rotating chevron, the collapsed-summary / expanded-children swap and the per-card error boundary, so
// every monitor collapses, reads back and fails the same way. Every mount starts collapsed; nothing is persisted.
import { Component, useId, useState } from 'react';
import type { ReactNode } from 'react';

export interface MonitorCardProps {
  title: string;
  /** What the collapsed card shows instead of the full body (one compact line per row, typically). */
  summary: ReactNode;
  /** The full body, shown only while expanded. */
  children: ReactNode;
  /** Header content that only makes sense once the card is open (range toggles and the like). */
  headerExtra?: ReactNode;
  /** Rendered after the body in both states (freshness lines and the like). */
  footer?: ReactNode;
  /** Replaces summary and children in both states (failure blocks, empty notes). */
  status?: ReactNode;
  className?: string;
}

/** One card, one blast radius: a summary or tile that throws while rendering shows the card's own apology note
 * instead of blanking the Dashboard around it. It logs nothing — errors may carry vault text. */
class MonitorBody extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed) {
      return <p className="dash-note" role="status">{this.props.title} could not be shown.</p>;
    }
    return this.props.children;
  }
}

export function MonitorCard({ title, summary, children, headerExtra, footer, status, className = '' }: MonitorCardProps) {
  const headingId = useId();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={'dash-card monitor ' + className} aria-labelledby={headingId}>
      <header className="dash-card-head">
        <h2 id={headingId}>
          <button type="button" className="monitor-head" aria-expanded={expanded} aria-controls={bodyId}
            onClick={() => setExpanded((open) => !open)}>
            {title}
            <svg className="monitor-chevron" aria-hidden="true" focusable="false" viewBox="0 0 12 12" width="12" height="12">
              <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </h2>
        {expanded && headerExtra}
      </header>
      <div className="monitor-body" id={bodyId}>
        <MonitorBody title={title}>
          {status !== undefined ? status : expanded ? children : summary}
        </MonitorBody>
        {footer}
      </div>
    </section>
  );
}
