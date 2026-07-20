// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bundled demo template. Wrangler doesn't expose worker/demo-template.json
// as a runtime asset (the [assets] binding serves web/dist, not worker/),
// so we import the JSON at build time via Node's JSON resolution. TypeScript
// needs `resolveJsonModule` (already on in worker/tsconfig.json) to accept
// the import. The shape is enforced by the DemoTemplate type.

import templateJson from "../../demo-template.json";

export interface DemoTemplate {
  features?: Record<string, number>;
  feature_strings?: Record<string, string>;
  user_permissions?: Record<string, Record<string, boolean>>;
  storage_sources_keep_prefixes?: string[];
}

export const defaultTemplate: DemoTemplate = templateJson as DemoTemplate;