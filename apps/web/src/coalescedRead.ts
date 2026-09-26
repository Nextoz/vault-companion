export type ReadReason = 'wake' | 'refresh' | 'receipt';

/** Per read kind: wakes that fire together (focus + visibilitychange + online on one app switch) share one read.
 * A wake joins only an in-flight read another wake started; every other read runs fresh, so a read that must see a
 * newer vault state (a receipt, the Refresh button, a wake after a read finished) never gets an older answer.
 * No I/O or scheduling belongs here.
 */
export function coalescedRead<T>(read: () => Promise<T>) {
  let wakeFlight: Promise<T> | null = null;

  return (reason: ReadReason = 'refresh'): Promise<T> => {
    if (reason === 'wake' && wakeFlight) return wakeFlight;
    const flight = Promise.resolve().then(read);
    if (reason === 'wake') {
      wakeFlight = flight;
      const clear = () => {
        if (wakeFlight === flight) wakeFlight = null;
      };
      flight.then(clear, clear);
    }
    return flight;
  };
}
