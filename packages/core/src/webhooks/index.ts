/**
 * Outgoing webhooks for every service (B081, CT-WEBHOOKS): the event vocabulary and data rules,
 * `emitWebhookEvent`, and signing. Also published as `@centcom/core/webhooks`.
 */
export {
  createWebhookEventEmitter,
  InvalidWebhookEventError,
  isWebhookEventType,
  SUBSCRIBABLE_EVENT_TYPES,
  WEBHOOK_API_VERSION,
  WEBHOOK_DATA_FIELDS,
  WEBHOOK_DEAD_QUEUE,
  WEBHOOK_DELIVER_QUEUE,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_EVENTS_QUEUE,
  webhookDataProblems,
  type WebhookEmitterDeps,
  type WebhookEvent,
  type WebhookEventInput,
  type WebhookEventQueue,
  type WebhookEventType,
  type WebhookOutbox,
} from './events.js';
export { signPayload, verifySignature, WEBHOOK_SIGNATURE_TOLERANCE_S } from './signing.js';
