/**
 * Trials, coupons and promotions (B079): the service behind
 * `POST /v1/workspaces/{id}/coupons/redeem`, `grantPromotion` for B087, trial eligibility for
 * B071, the trial hooks for B072, their repository, configuration and parsers. See README.md.
 */
export { codeHash, MAX_CODE_LENGTH, normaliseCode } from './codes.js';
export {
  DEFAULT_REDEEM_RATE,
  DEFAULT_TRIAL_DAYS,
  loadPromotionConfig,
  promotionEnvSchema,
  REDEEM_WINDOW_S,
  type PromotionConfig,
} from './config.js';
export type {
  ApplyPromotionInput,
  PromotionStripe,
  SubscriptionDiscounts,
  TrialMail,
} from './ports.js';
export {
  checkPromotion,
  parsePromotionCode,
  type PromotionCode,
  type PromotionRefusal,
  type PromotionTarget,
} from './promotion-code.js';
export {
  createPromotionRepository,
  type PromotionRepository,
  type RecordOutcome,
  type StoredRedemption,
  type RedemptionRow,
  type TrialRow,
} from './repository.js';
export {
  PROMOTION_DETAILS,
  PROMOTION_LOCK_TTL_MS,
  PROMOTION_LOCK_WAIT_MS,
  PromotionService,
  type PromotionServiceDeps,
  type RedeemInput,
  type RefusalReason,
  type StaffActor,
} from './service.js';
export { TRIAL_ENDING_TEMPLATE, TRIAL_ENDING_TEMPLATE_ID } from './trial-mail.js';
export { TrialService, type TrialEligibility, type TrialServiceDeps } from './trials.js';
