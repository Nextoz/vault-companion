// w7: the Barometer monitor — sea-level pressure at Trianglen (DMI stations, Open-Meteo model fallback), one card on
// the Board. The card fetches itself (read-only `/api/barometer`, retried on demand) and every line it shows comes
// from the w5 helpers in barometer.ts and the w6 dial; failure words are the provider's own, never invented here.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BAROMETER_SOURCE_LABELS, type BarometerResponse, type BarometerTrend } from '@vault-companion/contracts';
import { getBarometer, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { BarometerDial } from './BarometerDial.tsx';
import { baroCaption, baroStale, baroSummary, changeText, obsTime, type BarometerOk } from './barometer.ts';
import './Barometer.css';

const BARO_FAILED = 'Barometer could not be loaded. No value is shown.';

/** The trend colour, shared by the summary's arrow clause and the caption's trend words. */
function trendClass(trend: BarometerTrend): string {
  return trend === 'rising' ? 'baro-rising' : trend === 'falling' ? 'baro-falling' : 'baro-steady';
}

/** One of the helpers' one-line texts with only its trend clause — the second ` · ` part — wrapped in the trend
 * colour (up to " in 3 h"); the whole line stays plain when there is no three-hour history. */
function trendClause(text: string, r: BarometerOk): ReactNode {
  const change = changeText(r);
  if (r.trend === null || change === null) return text;
  const [head, clause, ...rest] = text.split(' · ');
  if (head === undefined || clause === undefined) return text;
  const tail = rest.join(' · ');
  // Only the arrow/word and the number carry the trend colour (mockup); "in 3 h" stays in the text colour.
  const split = clause.indexOf(' in ');
  const coloured = split === -1 ? clause : clause.slice(0, split);
  const plain = split === -1 ? '' : clause.slice(split);
  return (
    <>
      {head} · <span className={trendClass(r.trend)}>{coloured}</span>{plain}{tail.length > 0 ? ` · ${tail}` : ''}
    </>
  );
}

export function BarometerMonitor() {
  const [retry, setRetry] = useState(0);
  const [res, setRes] = useState<Fetched<BarometerResponse> | null>(null);
  // One read per mount; the Retry button bumps `retry` to fetch again. A late answer never lands on an unmounted card.
  useEffect(() => {
    let live = true;
    void getBarometer().then((result) => { if (live) setRes(result); });
    return () => { live = false; };
  }, [retry]);
  const data = res !== null && res.kind === 'ok' ? res.data : null;
  const ok = data !== null && data.status === 'ok' ? data : null;
  const stale = ok !== null && baroStale(ok, Date.now());
  return (
    <MonitorCard
      title="Barometer"
      className="barometer"
      status={res === null ? (
        <p className="dash-note" role="status">Loading barometer…</p>
      ) : res.kind !== 'ok' ? (
        <div className="baro-failure">
          <p className="dash-note" role="status">{BARO_FAILED}</p>
          <button type="button" className="link" onClick={() => setRetry((previous) => previous + 1)}>Retry</button>
        </div>
      ) : res.data.status === 'unavailable' ? (
        <p className="dash-note" role="status">{res.data.note}</p>
      ) : undefined}
      summary={<p className="baro-summary">{ok !== null ? trendClause(baroSummary(ok), ok) : ''}</p>}
      footer={ok !== null && (
        <p className={stale ? 'dash-stale baro-footer' : 'muted small baro-footer'} role="status">
          {ok.source === 'model' ? <span className="baro-source-model">{BAROMETER_SOURCE_LABELS[ok.source]}</span> : BAROMETER_SOURCE_LABELS[ok.source]} · Trianglen · <time dateTime={ok.observedAt}>{obsTime(ok.observedAt)}</time>{stale ? ' · stale' : ''}
        </p>
      )}
    >
      {ok !== null && (
        <>
          <BarometerDial reading={ok} />
          <p className="baro-caption">{trendClause(baroCaption(ok), ok)}</p>
        </>
      )}
    </MonitorCard>
  );
}
