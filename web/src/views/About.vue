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

interface Dependency {
  name: string;
  version: string;
  url: string;
  license: string;
}

const credits: Credit[] = [
  {
    name: "FFmpeg",
    description: "Multimedia framework for audio processing and transcoding",
    url: "https://ffmpeg.org",
    license: "LGPL-2.1+ / GPL-2+"
  },
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

const dependencies: Dependency[] = [
  {
    name: "Vue.js",
    version: "3.5.34",
    url: "https://vuejs.org",
    license: "MIT"
  },
  {
    name: "Vue Router",
    version: "5.0.7",
    url: "https://router.vuejs.org",
    license: "MIT"
  },
  {
    name: "Pinia",
    version: "3.0.4",
    url: "https://pinia.vuejs.org",
    license: "MIT"
  },
  {
    name: "Vue I18n",
    version: "11.4.5",
    url: "https://vue-i18n.intlify.dev",
    license: "MIT"
  },
  {
    name: "FFmpeg.wasm",
    version: "0.12.15",
    url: "https://github.com/ffmpegwasm/ffmpeg.wasm",
    license: "LGPL-2.1"
  },
  {
    name: "music-metadata",
    version: "11.13.0",
    url: "https://github.com/Borewit/music-metadata",
    license: "MIT"
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
      <h2>Referenced Projects</h2>
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

    <!-- Dependencies Section -->
    <section class="about-section">
      <h2>Core Dependencies</h2>
      <p class="section-description">
        Built with these wonderful open-source libraries:
      </p>
      <div class="deps-list">
        <div v-for="dep in dependencies" :key="dep.name" class="dep-item">
          <div class="dep-header">
            <h3>
              <a :href="dep.url" target="_blank" rel="noopener noreferrer">{{ dep.name }}</a>
            </h3>
            <span class="dep-version">{{ dep.version }}</span>
          </div>
          <p class="dep-license">{{ dep.license }}</p>
        </div>
      </div>
    </section>

    <!-- Subsonic Compatibility -->
    <section class="about-section">
      <h2>Subsonic Compatibility</h2>
      <div class="compatibility-box">
        <p>
          EdgeSonic implements the
          <a href="https://www.subsonic.org/pages/api.jsp" target="_blank" rel="noopener noreferrer">
            Subsonic REST API
          </a>
          and extends it with
          <a href="https://opensubsonic.netlify.app" target="_blank" rel="noopener noreferrer">
            OpenSubsonic
          </a>
          protocol enhancements.
        </p>
        <p>
          This means you can use EdgeSonic with any Subsonic-compatible client, including
          <strong>music-tag-web</strong>, <strong>Navidrome clients</strong>, and many others.
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
  margin-bottom: 1rem;
}

.about-logo {
  width: 120px;
  height: 120px;
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
.copyright-box p:first-child {
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

.deps-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.dep-item {
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem;
}

.dep-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.dep-item h3 {
  margin: 0;
  font-size: 1.1rem;
}

.dep-item h3 a {
  color: var(--color-primary);
  text-decoration: none;
}

.dep-item h3 a:hover {
  text-decoration: underline;
}

.dep-version {
  color: var(--color-text-tertiary);
  font-size: 0.9rem;
  white-space: nowrap;
  background: var(--color-background-tertiary);
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
}

.dep-license {
  margin: 0;
  font-size: 0.9rem;
  color: var(--color-text-secondary);
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
    width: 80px;
    height: 80px;
  }

  .credits-grid {
    grid-template-columns: 1fr;
  }

  .dep-header {
    flex-direction: column;
    align-items: flex-start;
  }
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .license-box,
  .copyright-box,
  .compatibility-box,
  .credit-card,
  .dep-item {
    background: var(--color-background-secondary);
  }
}
</style>
