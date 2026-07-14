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

const dependencies: Array<{ name: string; version: string; license: string; url: string }> = [
  {
    name: "Vue",
    version: "3.5.34",
    license: "MIT",
    url: "https://github.com/vuejs/core"
  },
  {
    name: "Vite",
    version: "8.0.14",
    license: "MIT",
    url: "https://github.com/vitejs/vite"
  },
  {
    name: "Vue Router",
    version: "5.0.7",
    license: "MIT",
    url: "https://github.com/vuejs/router"
  },
  {
    name: "Pinia",
    version: "3.0.4",
    license: "MIT",
    url: "https://github.com/vuejs/pinia"
  },
  {
    name: "Vue I18n",
    version: "11.4.5",
    license: "MIT",
    url: "https://github.com/intlify/vue-i18n"
  },
  {
    name: "FFmpeg",
    version: "0.12.15",
    license: "LGPL",
    url: "https://github.com/ffmpegwasm/ffmpeg.wasm"
  },
  {
    name: "music-metadata",
    version: "11.13.0",
    license: "MIT",
    url: "https://github.com/Borewit/music-metadata"
  },
  {
    name: "Hono",
    version: "4.x",
    license: "MIT",
    url: "https://github.com/honojs/hono"
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
      <p class="tagline">{{ t('about.tagline') || 'Subsonic-compatible music streaming server on Cloudflare Workers' }}</p>
    </div>

    <!-- License Section -->
    <section class="about-section">
      <h2>{{ t('about.license_title') || 'License' }}</h2>
      <div class="license-box">
        <p>
          {{ t('about.license_text') || 'EdgeSonic is licensed under the' }}
          <strong>GNU Affero General Public License v3.0 (AGPL-3.0)</strong>
        </p>
        <p>
          {{ t('about.license_desc') || 'This means that if you modify and use EdgeSonic over a network, you must make your modifications available to other users under the same license.' }}
        </p>
        <p>
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
            {{ t('about.read_license') || 'Read the full AGPL-3.0 license →' }}
          </a>
        </p>
      </div>
    </section>

    <!-- About Section -->
    <section class="about-section">
      <h2>{{ t('about.about_title') || 'About' }}</h2>
      <div class="about-box">
        <p>
          {{ t('about.about_desc') || 'EdgeSonic is an open-source, self-hosted music streaming server built on Cloudflare Workers.' }}
        </p>
        <p>
          {{ t('about.source_code') || 'All source code is available on' }}
          <a href="https://github.com/wuyilingwei/edgesonic" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </section>

    <!-- Copyright Section -->
    <section class="about-section">
      <h2>{{ t('about.copyright_title') || 'Copyright' }}</h2>
      <div class="copyright-box">
        <p>{{ t('about.copyright_text') || 'Copyright © 2022-2026 EdgeSonic Contributors' }}</p>
      </div>
    </section>


    <!-- Compatibility Section -->
    <section class="about-section">
      <h2>{{ t('about.compatibility_title') || 'Compatibility' }}</h2>
      <div class="compatibility-box">
        <p>
          <strong>{{ t('about.subsonic_compatible') || 'Subsonic API v1.16.1 compatible' }}</strong>
        </p>
        <p>
          {{ t('about.compatibility_desc') || 'EdgeSonic implements the Subsonic REST API (v1.16.1) and extends it with' }}
          <a href="https://opensubsonic.netlify.app" target="_blank" rel="noopener noreferrer">
            OpenSubsonic
          </a>
          {{ t('about.protocol_enhancements') || 'protocol enhancements.' }}
        </p>
      </div>
    </section>

    <!-- References Section -->
    <section class="about-section">
      <h2>{{ t('about.credits_title') || 'Credits & References' }}</h2>
      <p class="section-description">
        {{ t('about.credits_desc') || 'EdgeSonic is inspired by these excellent open-source projects:' }}
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
      <h2>{{ t('about.opensource_projects') || 'Open Source Projects' }}</h2>
      <p class="section-description">
        {{ t('about.powered_by') || 'EdgeSonic is built with these excellent open-source projects:' }}
      </p>
      <div class="dependencies-table">
        <div class="table-header">
          <div class="col-name">{{ t('about.project') || 'Project' }}</div>
          <div class="col-version">{{ t('about.version') || 'Version' }}</div>
          <div class="col-license">{{ t('about.license') || 'License' }}</div>
        </div>
        <a
          v-for="dep in dependencies"
          :key="dep.name"
          :href="dep.url"
          target="_blank"
          rel="noopener noreferrer"
          class="dependency-row"
        >
          <div class="col-name">{{ dep.name }}</div>
          <div class="col-version">{{ dep.version }}</div>
          <div class="col-license">{{ dep.license }}</div>
        </a>
      </div>
    </section>

    <!-- Footer -->
    <div class="about-footer">
      <p>{{ t('about.more_info') || 'For more information, visit' }} <a href="https://github.com/wuyilingwei/edgesonic" target="_blank" rel="noopener noreferrer">github.com/wuyilingwei/edgesonic</a></p>
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
.compatibility-box,
.about-box {
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.5rem;
}

.license-box p,
.copyright-box p,
.compatibility-box p,
.about-box p {
  margin: 0.75rem 0;
  line-height: 1.6;
}

.license-box p:first-child,
.copyright-box p:first-child,
.compatibility-box p:first-child,
.about-box p:first-child {
  font-weight: 500;
}

.license-box a,
.copyright-box a,
.compatibility-box a,
.about-box a {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 500;
}

.license-box a:hover,
.copyright-box a:hover,
.compatibility-box a:hover,
.about-box a:hover {
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

.dependencies-table {
  display: grid;
  grid-template-columns: 1fr;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}

.table-header {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  background: var(--color-background-secondary);
  font-weight: 600;
  font-size: 0.9rem;
  border-bottom: 1px solid var(--color-border);
  padding: 0;
}

.table-header > div {
  padding: 0.75rem 1rem;
  text-align: left;
}

.dependency-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  align-items: center;
  padding: 0;
  text-decoration: none;
  color: inherit;
  border-bottom: 1px solid var(--color-border-subtle);
  transition: background-color 0.2s ease;
}

.dependency-row:hover {
  background-color: var(--color-bg-tertiary);
}

.dependency-row > div {
  padding: 0.75rem 1rem;
  font-size: 0.9rem;
  text-align: left;
}

.col-name {
  font-weight: 500;
  color: var(--color-primary);
}

.col-version {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  font-family: var(--font-mono);
}

.col-license {
  color: var(--color-text-tertiary);
  font-size: 0.85rem;
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

  .table-header,
  .dependency-row {
    grid-template-columns: 1fr;
  }

  .table-header > div,
  .dependency-row > div {
    padding: 0.5rem 1rem;
  }
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .license-box,
  .copyright-box,
  .compatibility-box,
  .about-box,
  .credit-card {
    background: var(--color-background-secondary);
  }
}
</style>
