/** noopMetrics (B005): the default Metrics accepts every call, records nothing and is immutable. */
import { describe, expect, it } from 'vitest';
import { noopMetrics } from '../../src/index.js';

describe('noopMetrics', () => {
  it('accepts counters and histograms and records nothing', () => {
    const counter = noopMetrics.counter('http_requests_total', { route: '/v1/x' });
    const histogram = noopMetrics.histogram('http_request_duration_seconds', [0.1, 1]);
    expect(counter.inc()).toBeUndefined();
    expect(counter.inc(5)).toBeUndefined();
    expect(histogram.observe(0.2, { route: '/v1/x' })).toBeUndefined();
    expect(noopMetrics.counter('other')).toBe(counter);
  });

  it('is frozen, so no caller can swap its methods', () => {
    expect(Object.isFrozen(noopMetrics)).toBe(true);
    expect(Object.isFrozen(noopMetrics.counter('x'))).toBe(true);
    expect(Object.isFrozen(noopMetrics.histogram('x', []))).toBe(true);
  });
});
