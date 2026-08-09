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

import { HELP_ARTICLES } from '../src/help/content.ts'
import { MARKETING_PAGES } from '../src/marketing/pages.ts'

const ROUTES = [
  ['/', 'Lead Follow-Up CRM for Small Businesses | LogicFlower',
    'Reply to every lead in seconds with automated SMS and email follow-up, a simple CRM, appointment booking and review collection—without per-action fees.'],
  ['/blog', 'Blog — LogicFlower',
    'Practical writing about follow-up, booking and reputation for small businesses.'],
  ['/help', 'Help center — LogicFlower',
    'How everything works, written for a business owner rather than an engineer.'],
  ...MARKETING_PAGES.map((page) => [`/${page.kind === 'compare' ? 'compare' : page.kind === 'solution' ? 'solutions' : 'features'}/${page.slug}`, page.metaTitle, page.metaDescription]),
  ...HELP_ARTICLES.map((article) => [`/help/${article.slug}`, `${article.title} — LogicFlower help`, article.summary]),
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
  const socialPath = process.env.SOCIAL_IMAGE_PATH || '/social-card.jpg'
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

  // Generate Structured Data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: 'LogicFlower',
        url: canonicalBase,
        logo: `${canonicalBase}/logo-512.png`
      },
      {
        '@type': 'WebSite',
        name: 'LogicFlower',
        url: canonicalBase
      }
    ]
  }

  if (routePath === '/') {
    jsonLd['@graph'].push({
      '@type': 'SoftwareApplication',
      name: 'LogicFlower',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description,
      offers: [
        { '@type': 'Offer', name: 'Solo', category: 'SaaS', price: '0', priceCurrency: 'USD' },
        { '@type': 'Offer', name: 'Business', category: 'SaaS', price: '49', priceCurrency: 'USD' }
      ]
    })

    jsonLd['@graph'].push({
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'How is this cheaper than platforms that charge per action?',
          acceptedAnswer: { '@type': 'Answer', text: 'They bill for each step a workflow takes. We do not charge per action at all — you connect your own email and SMS accounts and pay those providers directly for the messages. The calculator above shows the workflow fees you would stop paying; it does not include message costs, which you pay either way.' }
        },
        {
          '@type': 'Question',
          name: 'What happens when someone replies mid-sequence?',
          acceptedAnswer: { '@type': 'Answer', text: 'Everything stops for that person, on every channel, immediately. Being chased three more times after you have already answered is the fastest way to lose a customer, so it is handled automatically rather than left to you to remember.' }
        },
        {
          '@type': 'Question',
          name: 'Do I need to be technical?',
          acceptedAnswer: { '@type': 'Answer', text: 'No. Pick your trade when you sign up and you get a pipeline, follow-up sequences and an inquiry form already written for it. Change anything you like afterwards.' }
        },
        {
          '@type': 'Question',
          name: 'Can I really post to social media?',
          acceptedAnswer: { '@type': 'Answer', text: 'Not yet, and we will say so plainly rather than surprise you. The composer, calendar and scheduling are built, but publishing needs each platform to approve our application — Meta, LinkedIn, TikTok and the rest. Those take weeks to months and some can be refused. We will announce it when it is genuinely working.' }
        },
        {
          '@type': 'Question',
          name: 'Is the AI calling available?',
          acceptedAnswer: { '@type': 'Answer', text: 'Not yet. The parts that keep automated calling lawful are built and tested — calling hours in the customer’s own timezone, do-not-call checks that block rather than assume, spoken disclosure, mid-call opt-out. The dialling itself needs a telephony provider connected, and we will not turn it on before that is done properly.' }
        },
        {
          '@type': 'Question',
          name: 'What happens to my data?',
          acceptedAnswer: { '@type': 'Answer', text: 'It stays yours. You can export everything, and delete it. Nobody from our team can open your workspace unless you approve it, that approval expires on its own, and you can see exactly who has access and withdraw it at any time.' }
        }
      ]
    })
  }

  const marketingPage = MARKETING_PAGES.find(p => routePath.endsWith(`/${p.slug}`))

  if (marketingPage) {
    jsonLd['@graph'].push({
      '@type': 'WebPage',
      '@id': `${canonical}#page`,
      name: marketingPage.metaTitle,
      description: marketingPage.metaDescription,
      url: canonical,
    })
    jsonLd['@graph'].push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: canonicalBase },
        { '@type': 'ListItem', position: 2, name: marketingPage.title, item: canonical },
      ],
    })
    if (marketingPage.faqs.length > 0) {
      jsonLd['@graph'].push({
        '@type': 'FAQPage',
        isPartOf: { '@id': `${canonical}#page` },
        mainEntity: marketingPage.faqs.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: { '@type': 'Answer', text: faq.answer },
        })),
      })
    }
  }

  const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`

  html = html.replace('</head>', `  ${head}\n    ${jsonLdScript}\n  </head>`)

  let extraContent = ''
  if (routePath === '/') {
    extraContent = `
      <section>
        <h2>From inquiry to booked job</h2>
        <p>LogicFlower connects to your website form and answers inquiries instantly.</p>
        <h3>Core Features</h3>
        <ul>
          <li>Missed Call Text Back</li>
          <li>Follow-Up Automation</li>
          <li>CRM for Trades</li>
          <li>Pipeline Management</li>
        </ul>
      </section>
      <section>
        <h2>Pricing</h2>
        <p>Start for free, upgrade when you need more power.</p>
        <ul>
          <li>Solo: $0 - Perfect for owner-operators.</li>
          <li>Business: $49/mo - Unlimited users, full automation.</li>
        </ul>
      </section>
      <section>
        <h2>Frequently Asked Questions</h2>
        <article>
          <h3>Do I have to build my own pipeline?</h3>
          <p>No. Pick your trade when you sign up and you get a pipeline, follow-up sequences and an inquiry form already written for it. Change anything you like afterwards.</p>
        </article>
      </section>`
  } else {
    // Check if it's a marketing page
    const marketingPage = MARKETING_PAGES.find(p => routePath.endsWith(`/${p.slug}`))
    if (marketingPage) {
      extraContent = `
        <nav aria-label="breadcrumb">
          <ol><li><a href="/">Home</a></li><li><a href="${routePath}/">${escapeHtml(marketingPage.title)}</a></li></ol>
        </nav>
        <article class="landing">
          <header>
            <p>${marketingPage.kind === 'compare' ? 'Comparison' : marketingPage.kind === 'solution' ? 'For your trade' : 'Feature'}</p>
            <h1>${escapeHtml(marketingPage.metaTitle)}</h1>
            <p>${escapeHtml(marketingPage.standfirst)}</p>
          </header>
          ${marketingPage.sections.map(s => `
            <section>
              <h2>${escapeHtml(s.heading)}</h2>
              <p>${escapeHtml(s.body)}</p>
              ${s.points?.length ? `<ul>${s.points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
            </section>
          `).join('')}
          ${marketingPage.caveat ? `<p>${escapeHtml(marketingPage.caveat)}</p>` : ''}
          <section>
            <h2>Questions</h2>
            <div class="faq">
              ${marketingPage.faqs.map(f => `
                <details>
                  <summary>${escapeHtml(f.question)}</summary>
                  <p>${escapeHtml(f.answer)}</p>
                </details>
              `).join('')}
            </div>
          </section>
          ${marketingPage.relatedSlugs?.length ? `
            <section>
              <h2>Related</h2>
              <ul>
                ${marketingPage.relatedSlugs.map(slug => {
                  const related = MARKETING_PAGES.find(p => p.slug === slug)
                  return related ? `<li><a href="/${related.kind === 'compare' ? 'compare' : related.kind === 'solution' ? 'solutions' : 'features'}/${slug}/">${escapeHtml(related.title)}</a></li>` : ''
                }).join('')}
              </ul>
            </section>
          ` : ''}
        </article>
      `
    } else {
      // Check if it's a help article
      const helpArticle = HELP_ARTICLES.find(a => routePath === `/help/${a.slug}`)
      if (helpArticle) {
        extraContent = `
          <nav aria-label="breadcrumb">
            <ol><li><a href="/">Home</a></li><li><a href="/help/">Help Center</a></li><li><a href="${routePath}/">${escapeHtml(helpArticle.title)}</a></li></ol>
          </nav>
          <article>
            <header>
              <h2>${escapeHtml(helpArticle.title)}</h2>
              <p>${escapeHtml(helpArticle.summary)}</p>
            </header>
            <section>
              <h3>What it is</h3>
              <p>${escapeHtml(helpArticle.whatItIs)}</p>
            </section>
            <section>
              <h3>Why use it</h3>
              <p>${escapeHtml(helpArticle.whyUseIt)}</p>
            </section>
            ${helpArticle.example ? `
              <section>
                <h3>Example</h3>
                <p>${escapeHtml(helpArticle.example)}</p>
              </section>
            ` : ''}
            <section>
              <h3>Steps</h3>
              <ol>
                ${helpArticle.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
              </ol>
            </section>
            ${helpArticle.terms?.length ? `
              <section>
                <h3>Terms</h3>
                <dl>
                  ${helpArticle.terms.map(t => `<dt>${escapeHtml(t.term)}</dt><dd>${escapeHtml(t.meaning)}</dd>`).join('')}
                </dl>
              </section>
            ` : ''}
            ${helpArticle.whatHappensNext ? `
              <section>
                <h3>What happens next</h3>
                <p>${escapeHtml(helpArticle.whatHappensNext)}</p>
              </section>
            ` : ''}
            ${helpArticle.problems?.length ? `
              <section>
                <h3>Common problems</h3>
                <dl>
                  ${helpArticle.problems.map(p => `<dt>${escapeHtml(p.problem)}</dt><dd>${escapeHtml(p.answer)}</dd>`).join('')}
                </dl>
              </section>
            ` : ''}
          </article>
        `
      } else if (routePath === '/help') {
        extraContent = `
          <nav aria-label="breadcrumb">
            <ol><li><a href="/">Home</a></li><li><a href="/help/">Help Center</a></li></ol>
          </nav>
          <section>
            <h2>Help Center Categories</h2>
            <ul>
              <li>Workspace Setup</li>
              <li>CRM and Contacts</li>
              <li>Automation Sequences</li>
              <li>Security and Billing</li>
            </ul>
          </section>`
      }
    }
  }

  // Inject a basic HTML shell into the root div so non-JS crawlers see the content
  const isCustomArticle = routePath.startsWith('/features/') || routePath.startsWith('/solutions/') || routePath.startsWith('/compare/') || routePath.startsWith('/help/')
  const fallbackHtml = `
    <header>
      <nav>
        <a href="/">LogicFlower</a>
        <a href="/features/missed-call-text-back/">Missed Call Text Back</a>
        <a href="/features/follow-up-automation/">Follow-Up Automation</a>
        <a href="/solutions/crm-for-trades/">CRM for Trades</a>
        <a href="/compare/logicflower-vs-per-action-pricing/">Pricing Comparison</a>
        <a href="/blog/">Blog</a>
        <a href="/help/">Help Center</a>
      </nav>
    </header>
    <main>
      ${isCustomArticle ? extraContent : `
        <h1>${escapeHtml(title.split(' | ')[0].split(' — ')[0])}</h1>
        <p>${escapeHtml(description)}</p>
        ${extraContent}
      `}
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
    console.warn(`prerender: using ${'/social-card.jpg'} as the share card. Set SOCIAL_IMAGE_PATH to a purpose-built 1200x630 image for better results.`)
  }
  if (!process.env.CANONICAL_ORIGIN) {
    // Canonical URLs must be absolute to be useful. A relative one is ignored
    // by most crawlers and by every social scraper.
    console.warn('prerender: CANONICAL_ORIGIN is not set, so canonical URLs are relative. Set it to your public origin before a production build.')
  }
}

main()
