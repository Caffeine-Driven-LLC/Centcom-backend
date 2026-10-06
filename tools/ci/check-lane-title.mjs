// @ts-check
/**
 * Pull request title check (B002, GUIDELINES §0): a lane PR title starts with its lane ID,
 * e.g. `B037: relay service skeleton`.
 *
 * Usage: node tools/ci/check-lane-title.mjs "<title>"   exits 0 for a lane title, 1 otherwise.
 */
import { fileURLToPath } from 'node:url';

/** `B` + three digits, a colon, one space, then a non-blank summary. */
export const LANE_TITLE = /^B\d{3}: \S/;

/**
 * True when `title` is a valid backend lane PR title.
 * @param {unknown} title
 * @returns {boolean}
 */
export function isLaneTitle(title) {
  return typeof title === 'string' && LANE_TITLE.test(title);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const title = process.argv[2] ?? '';
  if (!isLaneTitle(title)) {
    console.error(
      `PR title must start with a lane ID, like "B037: relay service skeleton". Got: ${JSON.stringify(title)}`,
    );
    process.exit(1);
  }
}
