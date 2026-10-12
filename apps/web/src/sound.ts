// ADR-0064: reward sounds, synthesised with Web Audio (no audio files, nothing to license). WoW-inspired, not copied:
// a soft tick for XP, a bright double ping for a critical, a sparkly arpeggio for an achievement and a rising brass
// swell for a level up. Every call is a silent no-op where Web Audio is missing, blocked or muted on this device.

export type RewardSound = 'xp' | 'critical' | 'achievement' | 'title' | 'level';

const KEY = 'vc.sound';
/** The session's setting; storage only persists it, so a refused write still silences this session. */
let enabled: boolean | null = null;

/** On by default; the Character sheet toggles it. Storage errors read as on and are never thrown. */
export function soundEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    enabled = localStorage.getItem(KEY) !== '0';
  } catch {
    enabled = true;
  }
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not remembered in private mode; this session still follows the switch.
  }
}

type AudioContextCtor = new () => AudioContext;
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context !== null) return context;
  const Ctor = (globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }).AudioContext
    ?? (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/** Not running: 'suspended' before a gesture, and iOS's 'interrupted' after the app was in the background. */
const needsResume = (ctx: AudioContext): boolean => (ctx.state as string) !== 'running' && (ctx.state as string) !== 'closed';

/**
 * iOS starts an AudioContext suspended until a user activation, and `pointerdown` from a touch does not count; the
 * reward plays after a network read, outside the tap. So every activating event (touchend, pointerup, click) resumes
 * a stopped context, and so does returning to the app (iOS interrupts audio in the background). The iPhone silent
 * switch still silences Web Audio, by design.
 */
export function unlockAudioOnFirstTap(): () => void {
  const unlock = () => {
    const ctx = audio();
    if (ctx !== null && needsResume(ctx)) void ctx.resume().catch(() => undefined);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') unlock(); };
  const events = ['touchend', 'pointerup', 'click'] as const;
  for (const name of events) window.addEventListener(name, unlock, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    for (const name of events) window.removeEventListener(name, unlock);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

interface Note {
  readonly freq: number;
  readonly at: number;
  readonly dur: number;
  readonly type?: OscillatorType;
  readonly gain?: number;
  /** Glide to this frequency over the note (a sweep). */
  readonly to?: number;
}

function play(notes: readonly Note[], master = 0.5, lowpass?: { from: number; to: number; over: number }): void {
  const ctx = audio();
  if (ctx === null) return;
  // A context iOS interrupted may resume without a gesture; if it does not, this reward is silent.
  if (needsResume(ctx)) { void ctx.resume().then(() => { if (ctx.state === 'running') play(notes, master, lowpass); }).catch(() => undefined); return; }
  try {
    const now = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = master;
    let tail: AudioNode = out;
    if (lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(lowpass.from, now);
      filter.frequency.exponentialRampToValueAtTime(lowpass.to, now + lowpass.over);
      out.connect(filter);
      tail = filter;
    }
    tail.connect(ctx.destination);
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = note.type ?? 'triangle';
      osc.frequency.setValueAtTime(note.freq, now + note.at);
      if (note.to !== undefined) osc.frequency.exponentialRampToValueAtTime(note.to, now + note.at + note.dur);
      const peak = note.gain ?? 0.3;
      // Fast attack, exponential decay: a struck, bell-like shape rather than an organ tone.
      env.gain.setValueAtTime(0.0001, now + note.at);
      env.gain.exponentialRampToValueAtTime(peak, now + note.at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.dur);
      osc.connect(env).connect(out);
      osc.start(now + note.at);
      osc.stop(now + note.at + note.dur + 0.05);
    }
  } catch {
    // A rejected node or a closed context costs only the sound.
  }
}

const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.51, G6 = 1567.98, C7 = 2093;
const C4 = 261.63, G4 = 392, E4 = 329.63;

const SOUNDS: Readonly<Record<RewardSound, () => void>> = {
  xp: () => play([{ freq: 1200, to: 1700, at: 0, dur: 0.09, type: 'sine', gain: 0.18 }], 0.4),
  critical: () => play([
    { freq: G5, at: 0, dur: 0.12, gain: 0.25 },
    { freq: C6, at: 0.07, dur: 0.18, gain: 0.25 },
    { freq: G6, at: 0.07, dur: 0.25, type: 'sine', gain: 0.1 },
  ], 0.45),
  // A rising major arpeggio with a high shimmer on top: the "ding" of an earned achievement.
  achievement: () => play([
    { freq: C6, at: 0, dur: 0.35 },
    { freq: E6, at: 0.08, dur: 0.35 },
    { freq: G6, at: 0.16, dur: 0.4 },
    { freq: C7, at: 0.24, dur: 0.9, type: 'sine', gain: 0.22 },
    { freq: C7 * 1.5, at: 0.28, dur: 0.7, type: 'sine', gain: 0.06 },
    { freq: C5, at: 0.24, dur: 0.9, gain: 0.12 },
  ], 0.5),
  title: () => play([
    { freq: G5, at: 0, dur: 0.3 },
    { freq: C6, at: 0.1, dur: 0.4 },
    { freq: E6, at: 0.2, dur: 0.5 },
    { freq: G6, at: 0.3, dur: 1.0, type: 'sine', gain: 0.2 },
  ], 0.5),
  // A brass-like swell: sawtooth chord opening through a lowpass sweep, then a bright arpeggio over the top.
  level: () => {
    play([
      { freq: C4, at: 0, dur: 1.8, type: 'sawtooth', gain: 0.12 },
      { freq: G4, at: 0, dur: 1.8, type: 'sawtooth', gain: 0.1 },
      { freq: C5, at: 0.15, dur: 1.7, type: 'sawtooth', gain: 0.1 },
      { freq: E5, at: 0.3, dur: 1.6, type: 'sawtooth', gain: 0.08 },
      { freq: E4, at: 0.3, dur: 1.6, type: 'sawtooth', gain: 0.06 },
    ], 0.45, { from: 300, to: 4000, over: 0.9 });
    play([
      { freq: C6, at: 0.55, dur: 0.4 },
      { freq: E6, at: 0.65, dur: 0.4 },
      { freq: G6, at: 0.75, dur: 0.5 },
      { freq: C7, at: 0.85, dur: 1.2, type: 'sine', gain: 0.2 },
    ], 0.4);
  },
};

export function playReward(sound: RewardSound): void {
  if (!soundEnabled()) return;
  SOUNDS[sound]();
}
