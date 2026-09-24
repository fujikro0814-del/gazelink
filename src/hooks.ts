import { useEffect, useReducer } from 'react';
import type { Session } from './session/Session.ts';

/** Re-render on session notifications and additionally at `hz` for live readouts. */
export function useSession(session: Session, hz = 0): void {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const off = session.subscribe(force);
    const timer = hz > 0 ? setInterval(force, 1000 / hz) : null;
    return () => {
      off();
      if (timer) clearInterval(timer);
    };
  }, [session, hz]);
}

export function fmt(x: number | undefined | null, digits = 1, unit = ''): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '—';
  return `${x.toFixed(digits)}${unit}`;
}
