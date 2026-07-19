
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "vue-i18n";
import { useUpdateBanner } from "../stores/updateBanner";

const { t } = useI18n();
const banner = useUpdateBanner();
</script>

<template>
  <transition name="banner-slide">
    <div v-if="banner.available || banner.showStale" class="update-banner" role="alert" aria-live="polite">
      <div class="update-banner-inner">
        <div class="update-banner-text">
          <span class="update-banner-icon" aria-hidden="true">⟳</span>
          <div class="update-banner-copy">
            <div class="update-banner-title">{{ t("update.title") }}</div>
            <div class="update-banner-message">{{ t("update.message") }}</div>
          </div>
        </div>
        <div class="update-banner-actions">
          <button type="button" class="update-banner-btn-ghost" @click="banner.dismiss">
            {{ t("update.later") }}
          </button>
          <button type="button" class="update-banner-btn-primary" @click="banner.refresh">
            {{ t("update.refresh") }}
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.update-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 400;
  background: linear-gradient(90deg, rgba(20, 20, 22, 0.97), rgba(28, 28, 32, 0.97));
  border-bottom: 1px solid var(--color-accent-primary);
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 32px rgba(0, 0, 0, 0.5);
}
.update-banner-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0.7rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.update-banner-text {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex: 1;
  min-width: 0;
}
.update-banner-icon {
  font-size: 1.4rem;
  color: var(--color-accent-primary);
  animation: update-spin 2.4s linear infinite;
  flex-shrink: 0;
}
@keyframes update-spin {
  to { transform: rotate(360deg); }
}
.update-banner-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.update-banner-title {
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-sm, 0.85rem);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-accent-primary);
}
.update-banner-message {
  font-size: var(--fs-sm, 0.85rem);
  color: var(--color-text-secondary);
}
.update-banner-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}
.update-banner-btn-ghost,
.update-banner-btn-primary {
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-xs, 0.75rem);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 0.45rem 0.9rem;
  border-radius: 2px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.update-banner-btn-ghost {
  background: transparent;
  border: 1px solid var(--color-border-subtle, rgba(255,255,255,0.12));
  color: var(--color-text-secondary);
}
.update-banner-btn-ghost:hover {
  color: var(--color-text-primary);
  border-color: var(--color-text-secondary);
}
.update-banner-btn-primary {
  background: var(--color-accent-primary);
  border: 1px solid var(--color-accent-primary);
  color: var(--color-text-inverse, #0a0a0b);
}
.update-banner-btn-primary:hover {
  background: var(--color-text-primary);
  border-color: var(--color-text-primary);
}

/* slide-down transition */
.banner-slide-enter-active,
.banner-slide-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}
.banner-slide-enter-from,
.banner-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

@media (max-width: 600px) {
  .update-banner-inner {
    flex-direction: column;
    align-items: stretch;
    padding: 0.6rem 0.9rem;
  }
  .update-banner-actions {
    justify-content: flex-end;
  }
}
</style>
