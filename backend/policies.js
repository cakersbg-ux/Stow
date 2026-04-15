const DEFAULT_ARCHIVE_PREFERENCES = {
  compressionBehavior: "balanced",
  optimizationTier: "visually_lossless",
  stripDerivativeMetadata: true
};

const COMPRESSION_BEHAVIORS = new Set(["fast", "balanced", "max"]);
const OPTIMIZATION_TIERS = new Set(["lossless", "visually_lossless", "lossy_balanced", "lossy_aggressive"]);
const OPTIMIZATION_MODES = new Set([...OPTIMIZATION_TIERS, "pick_per_file"]);

const SESSION_IDLE_MINUTES_DEFAULT = 0;
const SESSION_IDLE_MINUTES_MAX = 24 * 60;

function normalizeEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeArchivePreferences(nextPreferences) {
  const source = nextPreferences && typeof nextPreferences === "object" ? nextPreferences : {};
  const optimizationMode = normalizeEnum(source.optimizationMode, OPTIMIZATION_MODES, undefined);
  const nextOptimizationTier =
    typeof source.optimizationTier === "string"
      ? source.optimizationTier
      : optimizationMode && optimizationMode !== "pick_per_file"
        ? optimizationMode
        : undefined;
  return {
    compressionBehavior: normalizeEnum(
      source.compressionBehavior,
      COMPRESSION_BEHAVIORS,
      DEFAULT_ARCHIVE_PREFERENCES.compressionBehavior
    ),
    optimizationTier: normalizeEnum(
      nextOptimizationTier,
      OPTIMIZATION_TIERS,
      DEFAULT_ARCHIVE_PREFERENCES.optimizationTier
    ),
    optimizationMode,
    stripDerivativeMetadata: normalizeBoolean(
      source.stripDerivativeMetadata,
      DEFAULT_ARCHIVE_PREFERENCES.stripDerivativeMetadata
    )
  };
}

function normalizeIdleMinutes(value, fallback) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  if (rounded <= 0) {
    return 0;
  }
  return Math.min(SESSION_IDLE_MINUTES_MAX, rounded);
}

function normalizeSessionPolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  const hasIdleMinutes = Object.prototype.hasOwnProperty.call(source, "idleMinutes");
  const hasLockOnHide = Object.prototype.hasOwnProperty.call(source, "lockOnHide");

  return {
    idleMinutes: hasIdleMinutes ? normalizeIdleMinutes(source.idleMinutes, null) : null,
    lockOnHide: hasLockOnHide && typeof source.lockOnHide === "boolean" ? source.lockOnHide : null
  };
}

function getGlobalSessionDefaults(settings) {
  return {
    idleMinutes: normalizeIdleMinutes(settings?.sessionIdleMinutes, SESSION_IDLE_MINUTES_DEFAULT) ?? SESSION_IDLE_MINUTES_DEFAULT,
    lockOnHide: typeof settings?.sessionLockOnHide === "boolean" ? settings.sessionLockOnHide : false
  };
}

function resolveEffectiveSessionPolicy(settings, archivePolicy) {
  const globalDefaults = getGlobalSessionDefaults(settings);
  return {
    idleMinutes: archivePolicy.idleMinutes ?? globalDefaults.idleMinutes,
    lockOnHide: archivePolicy.lockOnHide ?? globalDefaults.lockOnHide
  };
}

function computeSessionExpiry(lastActivityAt, idleMinutes) {
  if (idleMinutes <= 0) {
    return null;
  }
  return new Date(new Date(lastActivityAt).getTime() + idleMinutes * 60 * 1000).toISOString();
}

module.exports = {
  DEFAULT_ARCHIVE_PREFERENCES,
  computeSessionExpiry,
  normalizeArchivePreferences,
  normalizeIdleMinutes,
  normalizeSessionPolicy,
  resolveEffectiveSessionPolicy
};
