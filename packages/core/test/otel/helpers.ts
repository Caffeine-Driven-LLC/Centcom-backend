/**
 * Test helpers for telemetry (B093): an on-demand metric reader, the exported metrics flattened to
 * data points, and the repository's source files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** A reader collected by hand. */
export class TestReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** One exported data point. */
export interface Point {
  name: string;
  attributes: Record<string, unknown>;
  /** The sum, gauge value, or histogram count. */
  value: number;
  /** Histogram bucket bounds. */
  boundaries?: number[];
}

/** Every data point in `metrics`. */
export function points(metrics: ResourceMetrics): Point[] {
  const out: Point[] = [];
  for (const scope of metrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const dp of metric.dataPoints) {
        if (metric.dataPointType === DataPointType.HISTOGRAM) {
          const h = dp.value as { count: number; buckets: { boundaries: number[] } };
          out.push({
            name: metric.descriptor.name,
            attributes: { ...dp.attributes },
            value: h.count,
            boundaries: h.buckets.boundaries,
          });
        } else {
          out.push({
            name: metric.descriptor.name,
            attributes: { ...dp.attributes },
            value: dp.value as number,
          });
        }
      }
    }
  }
  return out;
}

/** A meter whose metrics `read()` collects. */
export function testMeter() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter('test'),
    read: async (): Promise<Point[]> => points((await reader.collect()).resourceMetrics),
  };
}

/** The repository's production source files (apps and packages, no tests or builds). */
export function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of ['apps', 'packages']) {
    for (const workspace of readdirSync(join(REPO, root))) {
      try {
        walk(join(REPO, root, workspace, 'src'));
      } catch {
        // a workspace without src
      }
    }
  }
  return files;
}

export const read = (path: string): string => readFileSync(path, 'utf8');
