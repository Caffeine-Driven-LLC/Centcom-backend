/**
 * Reactions and comments persistence (B062): reactions as a per-target set and comment pointers,
 * from sequenced frames. See README.md.
 */
export { reactionStage, type ReactionStageDeps } from './handler.js';
export * from './ports.js';
export {
  createPostgresCommentIndex,
  createPostgresReactionStore,
  type ReactionsDb,
} from './store.js';
