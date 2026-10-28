import type { RingDayResponse, RingSlot } from '@vault-companion/contracts';
// ADR-0068: the ring registry is confined to this deferred sheet and its layout helpers.
import { RING_METRICS, type RingMetric } from '@vault-companion/domain/ring-metrics';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { getRingDay, type Fetched } from '../api.ts';
import { groupStrips, hourTicks, lineSegments, metricLabel, metricValue, SLOT_MS, slotX } from './ring-day.ts';

const clock = (value: string | null | undefined) => value?.slice(11, 16) ?? '—';
const duration = (value: number | null | undefined) => value == null ? '—' : `${Math.floor(value / 60)} h ${value % 60}`;
const colour = (metric: RingMetric) => `var(--${metric.colour}, var(--hue-health))`;
const dayLabel = (date: string, long = false) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: long ? 'long' : 'short', day: 'numeric', ...(long ? { month: 'short' } as const : {}),
}).format(new Date(`${date}T12:00:00Z`));

function Strip({ day, name, metrics, selected, onSelect }: {
  day: RingDayResponse; name: string; metrics: RingMetric[]; selected: number; onSelect: (index: number) => void;
}) {
  const stage = metrics[0]!.chart === 'stage', h = stage ? 12 : name === 'hr' ? 54 : name === 'bp' ? 30 : 22;
  const x = (start: string) => slotX(start, day.dayStart, day.dayEnd) * 358;
  const values = day.slots.flatMap(slot => metrics.map(m => slot.values[m.key]).filter((v): v is number => v != null));
  const lo = metrics.some(m => m.chart === 'bars') ? 0 : Math.min(...values), hi = Math.max(...values);
  const y = (v: number) => h - 3 - (v - lo) / (hi - lo || 1) * (h - 6);
  const width = SLOT_MS / (Date.parse(day.dayEnd) - Date.parse(day.dayStart)) * 358;
  const latest = (m: RingMetric) => day.slots.findLast(s => s.values[m.key] != null)?.values[m.key];
  const shown = metrics.filter(m => !m.chart.startsWith('band-'));
  const low = metrics.find(m => m.chart === 'band-low'), high = metrics.find(m => m.chart === 'band-high');
  const bands = low && high ? lineSegments(day.slots.filter(s => s.values[high.key] != null), low) : [];
  const selectAt = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSelect(Math.max(0, Math.min(day.daySlots - 1, Math.floor((e.clientX - r.left) / r.width * day.daySlots))));
  };
  const release = (e: PointerEvent<SVGSVGElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return <div className="ring-strip">
    <div className="ring-strip-heading"><span>{name === 'hr' ? 'Heart rate (avg, min–max band)' : name === 'bp' ? 'Blood pressure' : stage ? 'Sleep' : metricLabel(metrics[0]!)}{metrics.some(m => m.labelUnverified) && ' (unverified)'}</span>
      <em>{shown.map(m => metricValue(latest(m), m)).join(' / ')}</em></div>
    <svg viewBox={`0 0 358 ${h}`} height={h} role="slider" tabIndex={0} aria-label={`${name} slot`} aria-valuemin={0} aria-valuemax={day.daySlots - 1} aria-valuenow={selected}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onSelect(Math.max(0, Math.min(day.daySlots - 1, selected + (e.key === 'ArrowRight' ? 1 : -1)))); } }}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); selectAt(e); }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) selectAt(e); }}
      onPointerUp={release} onPointerCancel={release}>
      <line x1="0" x2="358" y1={h - .5} y2={h - .5} stroke="var(--line)" />
      {bands.map((seg, i) => <polygon key={i} fill={colour(low!)} opacity=".22" points={[...seg.map(p => `${x(p.start)},${y(day.slots.find(s => s.start === p.start)!.values[high!.key]!)}`), ...seg.toReversed().map(p => `${x(p.start)},${y(p.value)}`)].join(' ')} />)}
      {shown.map(m => <g key={m.key} fill={colour(m)} stroke={colour(m)}>
        {m.chart === 'stage' ? day.slots.map(slot => {
          const v = slot.values[m.key]; if (v == null) return null;
          const before = metrics.slice(0, metrics.indexOf(m)).reduce((sum, other) => sum + (slot.values[other.key] ?? 0), 0);
          return <rect key={slot.start} stroke="none" x={x(slot.start) + before / 15 * width} y="0" width={v / 15 * width} height={h} />;
        }) : m.chart === 'bars' ? day.slots.map(slot => slot.values[m.key] == null ? null : <rect key={slot.start} stroke="none" x={x(slot.start)} y={h - slot.values[m.key]! / (hi || 1) * h} width={Math.max(0, width - .8)} height={slot.values[m.key]! / (hi || 1) * h} />)
          : lineSegments(day.slots, m).map((seg, i) => <g key={i}><polyline fill="none" strokeWidth="1.6" points={seg.map(p => `${x(p.start)},${y(p.value)}`).join(' ')} />{seg.map(p => <circle key={p.start} cx={x(p.start)} cy={y(p.value)} r="1.4" stroke="none" />)}</g>)}
      </g>)}
      <line x1={selected * width} x2={selected * width} y1="0" y2={h} stroke="var(--text)" strokeDasharray="3 2" />
    </svg>
  </div>;
}

export function RingDaySheet({ date: initialDate, onClose }: { date: string; onClose: () => void }) {
  const [date, setDate] = useState(initialDate), [read, setRead] = useState<Fetched<RingDayResponse> | null>(null);
  const [selected, setSelected] = useState(0), dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    return () => { if (invoker instanceof window.HTMLElement && invoker.isConnected) invoker.focus(); };
  }, []);
  useEffect(() => {
    let live = true; setRead(null); setSelected(0);
    void getRingDay(date).then(result => {
      if (!live) return;
      setRead(result);
      // Start on the newest stored slot (design A), not on an empty 00:00.
      const last = result.kind === 'ok' ? result.data.slots.at(-1) : undefined;
      if (last && result.kind === 'ok') setSelected(Math.round((Date.parse(last.start) - Date.parse(result.data.dayStart)) / SLOT_MS));
    });
    return () => { live = false; };
  }, [date]);
  const day = read?.kind === 'ok' ? read.data : null, night = day?.night;
  const start = day ? new Date(Date.parse(day.dayStart) + selected * SLOT_MS) : null;
  const slot: RingSlot | undefined = day?.slots.find(s => Date.parse(s.start) === start?.getTime());
  const selectedTime = (delta: number) => start ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' }).format(start.getTime() + delta) : '—';
  const tiles = [[night?.lightMin != null && night.deepMin != null ? duration(night.lightMin + night.deepMin) : '—', 'asleep'], [night?.restingHr ?? '—', 'resting HR'], [night?.hrvSdnnMs == null ? '—' : `${night.hrvSdnnMs} ms`, 'HRV (unverified)'], [duration(night?.deepMin), 'deep'], [night?.bodyTempC == null ? '—' : `${night.bodyTempC}°`, 'night temp'], [day ? `${day.slots.filter(s => Object.values(s.values).some(v => v != null)).length} / ${day.daySlots}` : '—', 'slots with data']];
  return <div className="sheet-backdrop" role="presentation"><section className="sheet ring-day" role="dialog" aria-modal="true" aria-label="Ring day" ref={dialog}
    onKeyDown={e => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      e.preventDefault(); controls[(controls.indexOf(document.activeElement as HTMLElement) + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }}>
    <div className="ring-top"><button className="link" onClick={onClose}>‹ Health</button><button className="link" disabled={!day} onClick={() => day && setDate(day.today)}>Today</button></div>
    <h1>Ring day</h1><div className="ring-nav"><button className="link" disabled={!day?.prevDate} onClick={() => day?.prevDate && setDate(day.prevDate)}>‹ {day?.prevDate ? dayLabel(day.prevDate) : 'Previous'}</button><b>{dayLabel(date, true)}</b><button className="link" disabled={!day?.nextDate} onClick={() => day?.nextDate && setDate(day.nextDate)}>{day?.nextDate ? dayLabel(day.nextDate) : 'Next'} ›</button></div>
    {!day ? <p role="status">{read === null ? 'Loading…' : 'Ring day could not be loaded.'}</p> : day.status !== 'ok' ? <p role="status">{day.status === 'missing' ? 'No ring data for this day.' : 'Ring data could not be read.'}</p> : <>
      <div className="ring-card"><div className="ring-label">Night {clock(night?.sleepStart)} – {clock(night?.sleepEnd)}</div><div className="ring-tiles">{tiles.map(([v, label]) => <div key={label}><b>{v}</b><small>{label}</small></div>)}</div></div>
      <div className="ring-card"><div className="ring-legend">{RING_METRICS.filter(m => m.chart === 'stage').map(m => <span key={m.key}><i style={{ background: colour(m) }} />{metricLabel(m)}</span>)}</div>
        {groupStrips().map(strip => <Strip key={strip.name} day={day} {...strip} selected={selected} onSelect={setSelected} />)}
        <div className="ring-axis">{hourTicks(day.dayStart, day.dayEnd).map((tick, i, ticks) => <span key={i} style={{ left: `${tick.x * 100}%` }}>{i % 3 === 0 || i === ticks.length - 1 ? tick.label : ''}</span>)}</div></div>
      <div className="ring-card"><div className="ring-label">{selectedTime(0)} – {selectedTime(SLOT_MS)} (selected slot)</div><div className="ring-values">{RING_METRICS.map(m => <div key={m.key} data-metric={m.key}><span>{metricLabel(m)}{m.labelUnverified && ' (unverified)'}</span><b>{metricValue(slot?.values[m.key], m)}</b></div>)}</div><p className="ring-note">— = no reading. {RING_METRICS.filter(m => m.labelUnverified).map(metricLabel).join(', ')} labels are unverified on this ring.</p></div>
    </>}
  </section></div>;
}
