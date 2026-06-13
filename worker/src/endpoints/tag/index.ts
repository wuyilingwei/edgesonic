// 055 — Tag management bucket. Mounted at /tag/* by router.ts. Every endpoint
// requires a web-session credential (auth.ts prefix check) plus the relevant
// permission (edit_tags / manage_sources / manage_files).
import { Hono } from "hono";
import { tagReadRoutes } from "./read";
import { tagEditRoutes } from "./write";
import { tidyFolderRoutes } from "./tidy";
import { scrapeRoutes } from "./scrape";
import { metadataRoutes } from "./submit";

export const tagRoutes = new Hono();

tagRoutes.route("/", tagReadRoutes);
tagRoutes.route("/", tagEditRoutes);
tagRoutes.route("/", tidyFolderRoutes);
tagRoutes.route("/", scrapeRoutes);
tagRoutes.route("/", metadataRoutes);
