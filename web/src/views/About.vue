// SPDX-License-Identifier: AGPL-3.0-or-later

<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const version = "1.1.0";

interface Credit {
  name: string;
  description: string;
  url: string;
  license?: string;
}

const credits: Credit[] = [
  {
    name: "Music Tag Web",
    description: "Web-based music metadata editor",
    url: "https://github.com/KyrieBetweenLovers/music-tag-web",
    license: "MIT"
  },
  {
    name: "Navidrome",
    description: "Subsonic-compatible music server",
    url: "https://www.navidrome.org",
    license: "GPL-3.0"
  },
];
</script>

<template>
  <div class="about-page">
    <!-- Header -->
    <div class="about-header">
      <div class="logo-container">
        <img src="/logo.svg" alt="EdgeSonic Logo" class="about-logo" />
      </div>
      <h1>EdgeSonic</h1>
      <p class="version">v{{ version }}</p>
      <p class="tagline">Subsonic-compatible music streaming server on Cloudflare Workers</p>
    </div>

    <!-- License Section -->
    <section class="about-section">
      <h2>License</h2>
      <div class="license-box">
        <p>
          EdgeSonic is licensed under the
          <strong>GNU Affero General Public License v3.0 or later (AGPL-3.0+)</strong>
        </p>
        <p>
          This means that if you modify and use EdgeSonic over a network, you must make your
          modifications available to other users under the same license.
        </p>
        <p>
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
            Read the full AGPL-3.0 license →
          </a>
        </p>
      </div>
    </section>

    <!-- Copyright Section -->
    <section class="about-section">
      <h2>Copyright</h2>
      <div class="copyright-box">
        <p>Copyright © 2022-2026 EdgeSonic Contributors</p>
        <p>
          EdgeSonic is an open-source project maintained by its community contributors.
          All source code is available on
          <a href="https://github.com/wuyilingwei/edgesonic" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </section>

    <!-- References Section -->
    <section class="about-section">
      <h2>Credits & References</h2>
      <p class="section-description">
        EdgeSonic is inspired by and compatible with these excellent projects:
      </p>
      <div class="credits-grid">
        <a v-for="credit in credits" :key="credit.name" :href="credit.url" target="_blank" rel="noopener noreferrer" class="credit-card">
          <h3>{{ credit.name }}</h3>
          <p>{{ credit.description }}</p>
          <p v-if="credit.license" class="license-badge">{{ credit.license }}</p>
        </a>
      </div>
    </section>

    <!-- Compatibility Section -->
    <section class="about-section">
      <h2>Compatibility</h2>
      <div class="compatibility-box">
        <p>
          <strong>Subsonic API v1.16.1 compatible</strong>
        </p>
        <p>
          EdgeSonic implements the Subsonic REST API (v1.16.1) and extends it with
          <a href="https://opensubsonic.netlify.app" target="_blank" rel="noopener noreferrer">
            OpenSubsonic
          </a>
          protocol enhancements.
        </p>
      </div>
    </section>

    <!-- Footer -->
    <div class="about-footer">
      <p>For more information, visit <a href="https://github.com/wuyilingwei/edgesonic" target="_blank" rel="noopener noreferrer">github.com/wuyilingwei/edgesonic</a></p>
    </div>
  </div>
</template>

<style scoped>
.about-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

.about-header {
  text-align: center;
  margin-bottom: 3rem;
  padding-bottom: 2rem;
  border-bottom: 1px solid var(--color-border);
}

.logo-container {
  margin-bottom: 1.5rem;
  display: flex;
  justify-content: center;
}

.about-logo {
  width: 200px;
  height: 200px;
  object-fit: contain;
}

.about-header h1 {
  font-size: 2.5rem;
  margin: 0;
  margin-bottom: 0.5rem;
  font-weight: 700;
}

.version {
  font-size: 1.2rem;
  color: var(--color-text-secondary);
  margin: 0 0 0.5rem 0;
}

.tagline {
  color: var(--color-text-tertiary);
  font-size: 1rem;
  margin: 0;
}

.about-section {
  margin-bottom: 2.5rem;
}

.about-section h2 {
  font-size: 1.5rem;
  margin-bottom: 1rem;
  color: var(--color-text-primary);
}

.section-description {
  color: var(--color-text-secondary);
  margin-bottom: 1rem;
}

.license-box,
.copyright-box,
.compatibility-box {
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.5rem;
}

.license-box p,
.copyright-box p,
.compatibility-box p {
  margin: 0.75rem 0;
  line-height: 1.6;
}

.license-box p:first-child,
.copyright-box p:first-child,
.compatibility-box p:first-child {
  font-weight: 500;
}

.license-box a,
.copyright-box a,
.compatibility-box a {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 500;
}

.license-box a:hover,
.copyright-box a:hover,
.compatibility-box a:hover {
  text-decoration: underline;
}

.credits-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}

.credit-card {
  display: block;
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.5rem;
  text-decoration: none;
  transition: all 0.2s ease;
  color: inherit;
}

.credit-card:hover {
  border-color: var(--color-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.credit-card h3 {
  margin: 0 0 0.5rem 0;
  color: var(--color-primary);
  font-size: 1.1rem;
}

.credit-card p {
  margin: 0.5rem 0;
  font-size: 0.95rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.license-badge {
  font-size: 0.85rem !important;
  color: var(--color-text-tertiary) !important;
  font-weight: 500 !important;
  margin-top: 0.75rem !important;
}

.about-footer {
  text-align: center;
  margin-top: 3rem;
  padding-top: 2rem;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.95rem;
}

.about-footer a {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 500;
}

.about-footer a:hover {
  text-decoration: underline;
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .about-page {
    padding: 1rem;
  }

  .about-header h1 {
    font-size: 2rem;
  }

  .about-logo {
    width: 150px;
    height: 150px;
  }

  .credits-grid {
    grid-template-columns: 1fr;
  }
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .license-box,
  .copyright-box,
  .compatibility-box,
  .credit-card {
    background: var(--color-background-secondary);
  }
}
</style>
