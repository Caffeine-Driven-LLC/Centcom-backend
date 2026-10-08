/**
 * Release manifests and update channels (B084, CT-API-RELEASES). Routes in `routes/releases.ts`;
 * publishing through `ReleasePublisher` (and `pnpm release:publish`). See README.md.
 */
export {
  channelView,
  RELEASES_CHANNEL,
  RELEASES_REFRESH_MS,
  RELEASES_STALE_MS,
  ReleaseCache,
  releaseEtag,
  type Catalog,
  type ChannelView,
  type ReleaseCacheDeps,
  type Served,
} from './cache.js';
export { PUBLISH_EXIT, runPublishCli, type PublishCliDeps } from './cli.js';
export {
  loadReleasesConfig,
  releasesEnvSchema,
  type ReleaseKey,
  type ReleasesConfig,
} from './config.js';
export {
  ARCHS,
  CHANNELS,
  MANIFEST_MAX_BYTES,
  parseManifest,
  PLATFORMS,
  releaseOrder,
  verifySignatures,
  type Arch,
  type ParsedManifest,
  type Platform,
  type ReleaseArtifact,
  type ReleaseManifest,
} from './manifest.js';
export {
  MIN_CLIENT_VERSION_KEY,
  MIN_VERSION_SYNC_MS,
  MinClientVersionSync,
  stableMinClientVersion,
} from './min-version.js';
export {
  ReleasePublisher,
  type PublishOptions,
  type PublishResult,
  type ReleaseActor,
} from './publisher.js';
export {
  createReleaseRepository,
  type ReleaseRepository,
  type StoredRelease,
} from './repository.js';
