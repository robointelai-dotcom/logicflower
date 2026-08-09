import { Schema, model } from 'mongoose';

/**
 * A blog article on the public marketing site.
 *
 * Owned by the platform operator, not by a tenant: there is one public website,
 * and its content belongs to whoever runs the platform. So these carry no
 * organizationId, and the routes that write them are gated on the platform role
 * rather than a workspace membership.
 *
 * That is a deliberate exception to the tenant rule, and the tenant-isolation
 * guard has an explicit entry for it rather than a silent pass.
 */
const BlogPostSchema = new Schema({
  title: { type: String, required: true },
  /** URL segment. Immutable once published, or every existing link breaks. */
  slug: { type: String, required: true, unique: true },
  excerpt: { type: String, default: '' },
  /** Markdown. Rendered server-side so the browser never trusts raw HTML. */
  body: { type: String, default: '' },

  status: { type: String, enum: ['draft', 'scheduled', 'published', 'archived'], default: 'draft', index: true },
  /** When it becomes public. For a scheduled post this is in the future. */
  publishedAt: { type: Date, default: null, index: true },

  authorName: { type: String, default: '' },
  authorTitle: String,
  /**
   * The author as an entity, not a byline.
   *
   * `knowsAbout`, `alumniOf` and `sameAs` are what turn a name into something a
   * retrieval system can corroborate. They are emitted only where recorded —
   * an author node claiming expertise nobody entered is a fabrication.
   */
  authorKnowsAbout: { type: [String], default: [] },
  authorAlumniOf: { type: [String], default: [] },
  /** Verified public profiles only. These become `sameAs`. */
  authorSameAs: { type: [String], default: [] },
  authorBio: String,

  /**
   * Self-contained answers, each tied to a heading.
   *
   * Written to be lifted whole and quoted. Bounded at 40-60 words: shorter
   * usually drops the qualifier that makes the answer true, longer gets
   * truncated mid-thought by whatever quotes it.
   */
  answerCapsules: {
    type: [{ question: String, answer: String }],
    default: [],
  },

  /**
   * What this article knows that others do not — a benchmark we ran, a data set
   * we hold, an incident we handled. Recorded because an article with nothing
   * original in it is a summary of other people's work, and both readers and
   * ranking systems eventually notice.
   */
  informationGainSource: String,

  /**
   * Editorial verification.
   *
   * `dateReviewed` is deliberately separate from `updatedAt`: fixing a typo is
   * not a re-examination of whether the advice still holds, and conflating them
   * is how a stale article convinces everybody it is current.
   */
  dateReviewed: { type: Date, default: null },
  reviewedByName: String,
  reviewedByTitle: String,
  category: { type: String, default: 'General', index: true },
  tags: { type: [String], default: [], index: true },

  featuredImageArtifactId: { type: Schema.Types.ObjectId, default: null },
  /** Public URL of the featured image, once uploaded. */
  featuredImageUrl: { type: String, default: null },
  /**
   * Makes this article readable while unpublished, for review.
   *
   * Deliberately without an expiry: a review link that dies over a weekend is
   * one somebody works around by publishing early, which is the outcome the
   * preview exists to prevent. Rotating the token revokes the old link.
   */
  previewToken: { type: String, default: null, index: true },
  featuredImageAlt: String,

  /* ---- Search and social metadata ---- */
  seoTitle: String,
  metaDescription: String,
  canonicalUrl: String,
  noindex: { type: Boolean, default: false },
  ogTitle: String,
  ogDescription: String,
  /**
   * Editorial fields. These guide whoever writes the next article; they are
   * never emitted as markup. The meta keywords tag has been ignored by search
   * engines for well over a decade and putting these there would be cargo cult.
   */
  targetKeyword: String,
  secondaryKeywords: { type: [String], default: [] },
  searchIntent: { type: String, enum: ['informational', 'commercial', 'transactional', 'navigational', null], default: null },

  readingMinutes: { type: Number, default: 0 },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });

BlogPostSchema.index({ status: 1, publishedAt: -1 });
BlogPostSchema.index({ title: 'text', excerpt: 'text' });

export default model('BlogPost', BlogPostSchema);
