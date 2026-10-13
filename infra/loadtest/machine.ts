/**
 * Machine-wide CPU accounting from /proc (B095), so a load test can tell its own load from other
 * work on the same computer. On a shared laptop that matters: a build or test run next door makes a
 * healthy relay look slow, and the number would be a lie. A step measured while `foreignCores` is
 * high is marked noisy and measured again.
 */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

export interface CpuStat {
  busy: number;
  total: number;
  at: number;
}

/** Aggregate jiffies of all CPUs. */
export function readCpuStat(): CpuStat {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? '';
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
  const idleAll = idle + iowait;
  const total = user + nice + system + idleAll + irq + softirq + steal;
  return { busy: total - idleAll, total, at: performance.now() };
}

/** Cores kept busy between two readings. */
export function busyCores(a: CpuStat, b: CpuStat): number {
  const total = b.total - a.total;
  return total <= 0 ? 0 : ((b.busy - a.busy) / total) * cpus().length;
}

/** CPU jiffies (user + system) of a process, or 0 when it is gone. */
export function processJiffies(pid: number | undefined): number {
  if (pid === undefined) return 0;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
}

export const CLOCK_TICKS = 100;
