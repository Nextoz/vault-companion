import { SheetHeader } from './SheetHeader.tsx';
// CAL-b: the "Add to Calendar" / "In Calendar" bottom sheet. It writes Google Calendar directly through the API (the
// vault is never touched): no offline queue, so a failure shows inline instead of replaying later. One operation ID
// per open, so a repeated send is the same event; the pure decisions live in calendar-sheet.ts.
import { useEffect, useRef, useState } from 'react';
import { getMorningBrief, createCalendarEvent, removeCalendarEvent, type CalendarWriteResult } from '../api.ts';
import { dateIn } from '../time.ts';
import {
  CALENDAR_EVENT_TYPES, CALENDAR_TYPE_LABELS, CALENDAR_ZONE, NOTES_MAX,
  calendarChips, calendarErrorMessage, calendarPrefill, timedWindow,
  type CalendarChip, type CalendarEventType, type CalendarTarget,
} from './calendar-sheet.ts';
import { isMissingBrief } from './morning-card.ts';

/** A quiet calendar glyph in the row's secondary colour; presentational only. */
export function CalendarGlyph() {
  return (
    <svg className="calendar-glyph-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3 9.5h18M8 3v4M16 3v4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function CalendarSheet({ target, accountKey, onClose, onSaved }: {
  target: CalendarTarget;
  accountKey: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = dateIn(new Date().toISOString(), CALENDAR_ZONE);
  const initial = calendarPrefill({ text: target.text, due: target.due, scheduled: target.scheduled }, today);
  const [title, setTitle] = useState(initial.title);
  const [date, setDate] = useState(initial.date);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [type, setType] = useState<CalendarEventType>(initial.type);
  const [notes, setNotes] = useState(initial.notes);
  const [chips, setChips] = useState<CalendarChip[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One ID for this whole sheet: a double tap or a retry resolves to the one Google event.
  const [operationId] = useState(() => crypto.randomUUID());
  const guard = useRef(false);

  // Free-block chips come from the brief's own gaps; a failed or absent brief simply means no chips.
  useEffect(() => {
    let live = true;
    void getMorningBrief().then((res) => {
      if (live && res.kind === 'ok' && !isMissingBrief(res.data)) {
        setChips(calendarChips(res.data.brief.gaps, today));
      }
    });
    return () => { live = false; };
  }, [today]);

  const showFailure = (result: Exclude<CalendarWriteResult, { kind: 'ok' }>) => {
    if (result.kind === 'offline') setError(calendarErrorMessage('offline', null));
    else if (result.kind === 'signed-out') setError('Sign in again to change your calendar.');
    else setError(calendarErrorMessage('error', result.code));
  };

  const save = async () => {
    if (!accountKey || guard.current) return;
    const window = allDay ? null : timedWindow(date, start, end);
    if (!allDay && !window) { setError('Enter a valid start and end time.'); return; }
    guard.current = true; setSaving(true); setError(null);
    try {
      const result = await createCalendarEvent({
        operationId, itemKey: target.itemKey, title: title.trim() || 'Untitled event',
        ...(allDay ? { date } : { start: window!.start, end: window!.end }),
        type,
        ...(notes.trim() ? { notes: notes.trim().slice(0, NOTES_MAX) } : {}),
      }, accountKey);
      if (result.kind === 'ok') onSaved(); else showFailure(result);
    } finally { guard.current = false; setSaving(false); }
  };

  const remove = async () => {
    if (!accountKey || guard.current) return;
    guard.current = true; setSaving(true); setError(null);
    try {
      const result = await removeCalendarEvent({ operationId, itemKey: target.itemKey }, accountKey);
      if (result.kind === 'ok') onSaved(); else showFailure(result);
    } finally { guard.current = false; setSaving(false); }
  };

  const applyChip = (chip: CalendarChip) => {
    setAllDay(false);
    setStart(chip.startTime);
    setEnd(chip.endTime);
  };

  return (
    <div className="sheet-backdrop" role="presentation">
      <form className="sheet calendar-sheet" role="dialog" aria-modal="true"
        aria-label={target.linked ? 'In Calendar' : 'Add to Calendar'}
        onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <SheetHeader title={target.linked ? 'In Calendar' : 'Add to Calendar'} onClose={onClose} disabled={saving} closeLabel={target.linked ? 'Close' : 'Cancel'} />
        {error && <p role="alert" className="error">{error}</p>}
        {target.linked ? (
          <>
            <p className="muted small">This item is linked to a Google Calendar event.</p>
            <div className="sheet-buttons">
              <button type="button" className="calendar-remove" disabled={saving || !accountKey} onClick={() => void remove()}>
                Remove from Calendar
              </button>
            </div>
          </>
        ) : (
          <>
            <label>Date<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="calendar-allday">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All day
            </label>
            {!allDay && (
              <div className="calendar-times">
                <label>Start<input type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
                <label>End<input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} /></label>
              </div>
            )}
            {chips.length > 0 && (
              <div className="calendar-chips" role="group" aria-label="Free blocks today">
                {chips.map((chip) => (
                  <button type="button" key={chip.start} className="calendar-chip" onClick={() => applyChip(chip)}>
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
            <label>Title<input required maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label>Type
              <select value={type} onChange={(e) => setType(e.target.value as CalendarEventType)}>
                {CALENDAR_EVENT_TYPES.map((option) => <option key={option} value={option}>{CALENDAR_TYPE_LABELS[option]}</option>)}
              </select>
            </label>
            <label>Notes<textarea rows={3} maxLength={NOTES_MAX} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            <div className="sheet-buttons">
              <button type="submit" className="primary" disabled={saving || !accountKey || title.trim() === '' || date === ''}>Save</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
