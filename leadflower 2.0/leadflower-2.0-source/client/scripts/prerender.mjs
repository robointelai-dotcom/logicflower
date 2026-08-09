import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Write a real HTML file for every publicly reachable route.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The application is a single bundle. Every title, description and canonical is
 * set by JavaScript after the page loads. Google usually runs JavaScript, but
 * it is a second pass with a queue — and Bing, LinkedIn, Slack, WhatsApp and
 * most AI crawlers do not run it at all. They read the raw HTML, which until
 * now carried one generic description for the entire site.
 *
 * The practical symptom: share any blog post on LinkedIn and the preview card
 * shows the homepage blurb.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is not server-side rendering. The body still hydrates from the same
 * bundle, so behaviour is unchanged. What changes is that the HEAD of each page
 * is correct before a single line of JavaScript runs.
 *
 * That covers the routes known at build time. Blog articles live in the
 * database and cannot be known here, so the API serves those with the same
 * head injected at request time — see `serveArticleShell` on the server.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(here, '..', 'dist')
const templatePath = path.join(distDir, 'index.html')

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Routes whose content is fixed at build time.
 *
 * Kept in step with `server/src/services/content/publicRoutes.ts` by the test
 * that reads both. A page missing here is a page whose social preview is wrong.
 */
const HELP_ARTICLES = [
  ['what-is-logicflower', 'What LogicFlower does, in one page', 'It answers every enquiry quickly, keeps following up, and stops the moment they reply.'],
  ['setting-up-your-workspace', 'Setting up your workspace', 'One choice creates your pipeline, fields, follow-up and enquiry form.'],
  ['today-screen', 'The Today screen', 'What needs a person, and what is running without one.'],
  ['inbox-and-replies', 'The inbox, and what a reply does', 'One thread per person — and a reply stops all follow-up to them.'],
  ['contacts-and-fields', 'Adding a contact, and every field on it', 'What a contact record holds, and why an email or phone is required.'],
  ['using-tags', 'Tags, and how they drive automation', 'A tag can start follow-up, set a status or raise a task.'],
  ['importing-contacts', 'Importing a spreadsheet', 'Map the columns, preview every row, then approve.'],
  ['what-is-a-pipeline', 'Pipelines, stages and deals', 'Your work as a board — and moving a card is what starts follow-up.'],
  ['what-is-a-sequence', 'What a sequence is', 'Timed follow-up that stops the moment someone replies.'],
  ['writing-sequence-steps', 'Writing the steps', 'Channel, wait and message per step, plus quiet hours.'],
  ['unknown-send-outcomes', 'Sends with an unknown outcome', 'What they mean, and why you must not simply retry them.'],
  ['workflows-explained', 'Workflows: triggers, conditions and actions', 'The visual builder, for automation more complex than a straight sequence.'],
  ['booking-pages', 'Booking pages and availability', 'A link customers use to pick a time that is genuinely free.'],
  ['collecting-reviews', 'Asking for reviews', 'One request per customer, moderated by you, shown on your website.'],
  ['social-posting', 'Social posting, and why it is not live yet', 'You can compose and schedule now. Publishing waits on platform approval.'],
  ['ai-calling-safety', 'AI calling, and the rules it follows', 'Everything that keeps calling lawful is built. The dialling is not connected yet.'],
  ['writing-a-voice-agent', 'Writing a voice agent', 'Brief it as you would a new member of staff.'],
  ['who-can-see-your-data', 'Who can see your data', 'Nobody outside your business, unless you approve it — and it expires.'],
  ['agency-access', 'If an agency manages your workspace', 'You decide whether they can walk in or must ask each time.'],
  ['managing-clients', 'Managing client businesses', 'A triage board sorted by need, not alphabetically.'],
]

const LANDING_PAGES = [
  ['/features/missed-call-text-back', 'Missed Call Text Back Software for Small Businesses',
    'When you cannot answer, they get a text within seconds. Stop losing work to the next name on their list.'],
  ['/features/follow-up-automation', 'Automated Follow-Up for Small Businesses — Stops on Reply',
    'Multi-step follow-up by text and email that stops the moment somebody answers. No charge per message.'],
  ['/solutions/crm-for-trades', 'CRM for Trades — Plumbers, Electricians, Builders',
    'Quote-to-job pipeline, follow-up that stops on reply, and a booking link. Set up for your trade in a minute.'],
  ['/compare/logicflower-vs-per-action-pricing', 'Automation Without Per-Action Fees — A Cost Comparison',
    'Most platforms bill for every workflow step. Work out what that costs you at your own volume.'],
]

const ROUTES = [
  ['/', 'Lead Follow-Up CRM for Small Businesses | LogicFlower',
    'Reply to every lead in seconds with automated SMS and email follow-up, a simple CRM, appointment booking and review collection—without per-action fees.'],
  ['/blog', 'Blog — LogicFlower',
    'Practical writing about follow-up, booking and reputation for small businesses.'],
  ['/help', 'Help centre — LogicFlower',
    'How everything works, written for a business owner rather than an engineer.'],
  ...LANDING_PAGES,
  ...HELP_ARTICLES.map(([slug, title, description]) => [`/help/${slug}`, `${title} — LogicFlower help`, description]),
]

/**
 * Replace the head of the template.
 *
 * The body and the script tags are left exactly as Vite emitted them, so the
 * application hydrates normally. Only the metadata changes.
 */
function buildHtml(template, route) {
  const [routePath, title, description] = route
  const canonicalBase = process.env.CANONICAL_ORIGIN?.replace(/\/$/, '') ?? 'https://logicflower.com'
  let canonicalPath = routePath.endsWith('/') ? routePath : `${routePath}/`
  if (canonicalPath === '//') canonicalPath = '/' // prevent double slash for root
  const canonical = `${canonicalBase}${canonicalPath}`

  /*
   * The share card image.
   *
   * Must be ABSOLUTE. LinkedIn, Slack and WhatsApp fetch it from their own
   * servers, where a relative path resolves against nothing and the card comes
   * back blank — which is worse than no image, because the link looks broken
   * rather than plain.
   *
   * SOCIAL_IMAGE_PATH overrides the default for a purpose-built card.
   */
  const socialPath = process.env.SOCIAL_IMAGE_PATH || '/ecosystem.jpg'
  const socialImage = canonicalBase ? `${canonicalBase}${socialPath}` : ''

  const head = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    // Emitted only when it can be absolute. A relative og:image produces a
    // blank card, and a blank card reads as a broken link.
    socialImage ? `<meta property="og:image" content="${escapeHtml(socialImage)}">` : '',
    socialImage ? `<meta property="og:image:alt" content="${escapeHtml(title)}">` : '',
    `<meta property="og:site_name" content="LogicFlower">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta name="twitter:card" content="${socialImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    socialImage ? `<meta name="twitter:image" content="${escapeHtml(socialImage)}">` : '',
  ].filter(Boolean).join('\n    ')

  let html = template

  // Replace the template's own title and description rather than appending, or
  // a crawler taking the first match reads the generic one.
  html = html.replace(/<title>[\s\S]*?<\/title>/i, '')
  html = html.replace(/<meta\s+name="description"[^>]*>/i, '')
  html = html.replace(/<meta\s+(?:property|name)="(?:og:|twitter:)[^>]*>/ig, '')
  html = html.replace('</head>', `  ${head}\n  </head>`)

  // Inject a basic HTML shell into the root div so non-JS crawlers see the content
  const fallbackHtml = `
    <header>
      <nav>
        <a href="/">LogicFlower</a>
        <a href="/features/missed-call-text-back">Missed Call Text Back</a>
        <a href="/features/follow-up-automation">Follow-Up Automation</a>
        <a href="/solutions/crm-for-trades">CRM for Trades</a>
        <a href="/compare/logicflower-vs-per-action-pricing">Pricing Comparison</a>
        <a href="/blog/">Blog</a>
        <a href="/help/">Help Centre</a>
      </nav>
    </header>
    <main>
      <h1>${escapeHtml(title.split(' | ')[0].split(' — ')[0])}</h1>
      <p>${escapeHtml(description)}</p>
    </main>
  `
  html = html.replace('<div id="root"></div>', `<div id="root">${fallbackHtml}</div>`)

  return html
}

function main() {
  if (!fs.existsSync(templatePath)) {
    console.error('prerender: dist/index.html not found. Run the build first.')
    process.exitCode = 1
    return
  }
  const template = fs.readFileSync(templatePath, 'utf8')
  let written = 0

  for (const route of ROUTES) {
    const [routePath] = route
    const html = buildHtml(template, route)

    // "/" is the template itself; everything else becomes a directory with an
    // index.html, so nginx's `try_files $uri $uri/` finds it before falling
    // back to the SPA shell.
    const outPath = routePath === '/'
      ? templatePath
      : path.join(distDir, routePath.replace(/^\//, ''), 'index.html')

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from ROUTES, a constant in this file, and is written under dist/ during the build; no user input reaches it, and this stops being justified if routes ever come from elsewhere
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same constant-derived path as the mkdir above
    fs.writeFileSync(outPath, html)
    written += 1
  }

  console.log(`prerender: wrote ${written} pages with correct metadata`)
  if (!process.env.SOCIAL_IMAGE_PATH && process.env.CANONICAL_ORIGIN) {
    console.warn(`prerender: using ${'/ecosystem.jpg'} as the share card. Set SOCIAL_IMAGE_PATH to a purpose-built 1200x630 image for better results.`)
  }
  if (!process.env.CANONICAL_ORIGIN) {
    // Canonical URLs must be absolute to be useful. A relative one is ignored
    // by most crawlers and by every social scraper.
    console.warn('prerender: CANONICAL_ORIGIN is not set, so canonical URLs are relative. Set it to your public origin before a production build.')
  }
}

main()
