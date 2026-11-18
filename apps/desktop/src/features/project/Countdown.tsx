import { useEffect, useState } from 'react';
import { formatCountdown } from '../../lib/utils/format';

/** Live mm:ss until `until` (ISO). Calls `onDone` once when it reaches zero. */
export function Countdown({ until, onDone }: { until: string; onDone?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Date.parse(until) - now;
  useEffect(() => {
    if (remaining <= 0) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining <= 0]);
  return <span className="mono" data-testid="countdown">{formatCountdown(remaining)}</span>;
}
