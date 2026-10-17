// w6: the barometer dial for the markets screen — pure SVG from the "Dial geometry" section of
// .agent/briefs/screen-barometer.md, drawn with the w5 helpers (dialAngle, polar, arcPath, baroAria) and the zone
// table from the contract. Constant styling lives in Barometer.css behind the baro-* classes (written by w7);
// the only inline style is the per-zone arc colour. The caller (w7) owns fetching and failure states.
import { BAROMETER_ZONES, type BarometerZone } from '@vault-companion/contracts';
import { arcPath, baroAria, dialAngle, polar, type BarometerOk } from './barometer.ts';

// Dial geometry from the brief (viewBox 0 0 300 184): centre (150, 108), zone arcs at radius 88.
const CX = 150;
const CY = 108;
const R = 88;

/** Arc colour per zone (tokens only, no hex) — the one style that varies per zone, so it stays inline. */
const ZONE_COLOUR: Record<BarometerZone, string> = {
  Stormy: 'var(--danger)',
  Rain: 'var(--ios-orange)',
  Change: 'var(--muted)',
  Fair: 'var(--ios-cyan)',
  'Very dry': 'var(--done)',
};

/** Zone words at label radius 101 (each zone's mid-angle), at the exact x/y/anchor the brief lists. */
const ZONE_WORD: Record<BarometerZone, { x: number; y: number; anchor: 'start' | 'end' }> = {
  Stormy: { x: 49.3, y: 115.9, anchor: 'end' },
  Rain: { x: 104.1, y: 18.0, anchor: 'end' },
  Change: { x: 195.9, y: 18.0, anchor: 'start' },
  Fair: { x: 249.8, y: 92.2, anchor: 'start' },
  'Very dry': { x: 236.1, y: 160.8, anchor: 'start' },
};

/** One tick every 5 hPa across the 950-1050 span (21 ticks); majors every 25 hPa reach further in and draw thicker. */
const TICKS = Array.from({ length: 21 }, (_, i) => {
  const hPa = 950 + i * 5;
  const major = hPa % 25 === 0;
  const [x1, y1] = polar(CX, CY, 82, dialAngle(hPa));
  const [x2, y2] = polar(CX, CY, major ? 71 : 76, dialAngle(hPa));
  return { hPa, x1, y1, x2, y2, width: major ? 2 : 1 };
});

/** The dial for an `ok` reading: zone arcs, ticks, zone words, set hand, needle, hub, value — no caption inside. */
export function BarometerDial({ reading }: { reading: BarometerOk }) {
  const needle = dialAngle(reading.hPa); // the needle pegs at 950/1050, but the value text below never clamps
  const [tailX, tailY] = polar(CX, CY, -14, needle);
  const [tipX, tipY] = polar(CX, CY, 78, needle);
  // The reading three hours ago that the trend is measured against; no history means no set hand.
  const setHand =
    reading.hPaThreeHoursAgo !== null ? polar(CX, CY, 70, dialAngle(reading.hPaThreeHoursAgo)) : null;
  return (
    <svg className="baro-dial" viewBox="0 0 300 184" role="img" aria-label={baroAria(reading)}>
      {BAROMETER_ZONES.map((z) => (
        <path
          key={z.zone}
          className="baro-zone"
          style={{ stroke: ZONE_COLOUR[z.zone] }}
          d={arcPath(CX, CY, R, dialAngle(z.from), dialAngle(z.to))}
        />
      ))}
      {TICKS.map((t) => (
        <line key={t.hPa} className="baro-tick" strokeWidth={t.width} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
      ))}
      {BAROMETER_ZONES.map((z) => {
        const word = ZONE_WORD[z.zone];
        const on = z.zone === reading.zone;
        return (
          <text
            key={z.zone}
            className={on ? 'baro-word baro-word-on' : 'baro-word'}
            x={word.x}
            y={word.y}
            textAnchor={word.anchor}
          >
            {z.zone}
          </text>
        );
      })}
      {setHand !== null && <line className="baro-set" x1={CX} y1={CY} x2={setHand[0]} y2={setHand[1]} />}
      <line className="baro-needle" x1={tailX} y1={tailY} x2={tipX} y2={tipY} />
      <circle className="baro-hub" cx={CX} cy={CY} r={5} />
      <text className="baro-value" x={CX} y={150}>
        {reading.hPa.toFixed(1)}
      </text>
    </svg>
  );
}
