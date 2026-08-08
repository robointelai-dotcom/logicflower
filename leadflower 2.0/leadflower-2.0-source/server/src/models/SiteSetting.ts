import { Schema, model } from 'mongoose';

/**
 * Global settings for the public marketing site.
 *
 * A single document, keyed on a fixed identifier, so there is exactly one and
 * no code has to decide which of several is current.
 */
const SiteSettingSchema = new Schema({
  key: { type: String, required: true, unique: true, default: 'site' },
  siteTitle: { type: String, default: '' },
  siteDescription: { type: String, default: '' },
  /** Appended to a page's own title, e.g. "%s | LogicFlower". */
  titleTemplate: { type: String, default: '%s' },
  organizationName: String,
  /**
   * The one canonical origin. Every canonical URL and sitemap entry is built
   * from this, so the site cannot end up half on www and half not — which is
   * the most common way a site competes with itself in search results.
   */
  canonicalDomain: { type: String, default: '' },
  defaultSocialImageUrl: String,
  socialProfiles: { type: [String], default: [] },
  searchConsoleVerification: String,
  /**
   * Blocks the whole site from indexing. Exists for staging, and is deliberately
   * loud in the interface — a forgotten noindex is the single most expensive
   * SEO mistake there is.
   */
  robotsNoindexAll: { type: Boolean, default: false },
  updatedBy: String,
}, { timestamps: true });

export default model('SiteSetting', SiteSettingSchema);
