import React from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { Link, useParams } from '../router'
import { AppLogo } from '../components/ui'
import { MARKETING_PAGES, marketingPageBySlug, marketingPath, type MarketingPage } from '../marketing/pages'

/**
 * A marketing landing page.
 *
 * One page, one search intent. A homepage cannot rank for four different
 * queries at once, so each of these is written for exactly one and says so in
 * its own `intent` field.
 *
 * Structured data is a graph binding the page to its FAQ and to the site,
 * matching how the blog does it — a floating FAQ block states an unrelated
 * fact, where a bound one answers questions about a specific page.
 */

function useMeta(page: MarketingPage | undefined, canonicalPath: string) {
  React.useEffect(() => {
    if (!page) return
    document.title = page.metaTitle

    const upsert = (selector: string, create: () => HTMLElement, apply: (el: HTMLElement) => void) => {
      let element = document.head.querySelector(selector) as HTMLElement | null
      if (!element) { element = create(); document.head.appendChild(element) }
      apply(element)
      return element
    }

    upsert('meta[name="description"]',
      () => Object.assign(document.createElement('meta'), { name: 'description' }),
      (el) => el.setAttribute('content', page.metaDescription))

    upsert('link[rel="canonical"]',
      () => Object.assign(document.createElement('link'), { rel: 'canonical' }),
      (el) => el.setAttribute('href', `${window.location.origin}${canonicalPath}`))
  }, [page, canonicalPath])
}

export default function MarketingLandingPage() {
  const params = useParams()
  const page = marketingPageBySlug(params.slug ?? '')
  const canonicalPath = page ? marketingPath(page) : '/'
  useMeta(page, canonicalPath)

  if (!page) {
    return <div className="marketing"><section className="section"><h1>Page not found</h1><Link to="/">Back to the homepage</Link></section></div>
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${origin}${canonicalPath}#page`,
        name: page.metaTitle,
        description: page.metaDescription,
        url: `${origin}${canonicalPath}`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: page.title, item: `${origin}${canonicalPath}` },
        ],
      },
      // Bound to the page rather than floating, so the questions are understood
      // as being about this page.
      ...(page.faqs.length ? [{
        '@type': 'FAQPage',
        isPartOf: { '@id': `${origin}${canonicalPath}#page` },
        mainEntity: page.faqs.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: { '@type': 'Answer', text: faq.answer },
        })),
      }] : []),
    ],
  }

  return <div className="marketing">
    <script type="application/ld+json" dangerouslySetInnerHTML={{
      __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
    }} />

    <header className="marketing-nav">
      <Link to="/" className="marketing-brand"><AppLogo /></Link>
      <nav aria-label="Main"><Link to="/">Home</Link><Link to="/blog">Blog</Link><Link to="/help">Help</Link></nav>
      <div className="marketing-nav-actions"><Link to="/login">Sign in</Link><Link to="/signup" className="btn-primary-lg">Start free</Link></div>
    </header>

    <article className="landing">
      <header className="landing-head">
        <p className="eyebrow">{page.kind === 'compare' ? 'Comparison' : page.kind === 'solution' ? 'For your trade' : 'Feature'}</p>
        <h1>{page.title}</h1>
        <p className="landing-standfirst">{page.standfirst}</p>
        <Link to="/signup" className="btn-primary-lg">Start free<ArrowRight size={17} /></Link>
      </header>

      {page.sections.map((section) => <section key={section.heading} className="landing-section">
        <h2>{section.heading}</h2>
        <p>{section.body}</p>
        {Boolean(section.points?.length) && <ul className="landing-points">
          {section.points!.map((point) => <li key={point}><Check size={15} />{point}</li>)}
        </ul>}
      </section>)}

      {/* Stated on the page itself, not discovered after signing up. */}
      {page.caveat && <p className="landing-caveat">{page.caveat}</p>}

      <section className="landing-section">
        <h2>Questions</h2>
        <div className="faq">
          {page.faqs.map((faq) => <details key={faq.question} className="faq-item">
            <summary>{faq.question}</summary>
            <p>{faq.answer}</p>
          </details>)}
        </div>
      </section>

      {Boolean(page.relatedSlugs?.length) && <section className="landing-section">
        <h2>Related</h2>
        <div className="help-grid">
          {page.relatedSlugs!.map((slug) => {
            const other = marketingPageBySlug(slug)
            if (!other) return null
            return <Link key={slug} to={marketingPath(other)} className="help-card">
              <strong>{other.title}</strong>
              <span className="muted">{other.metaDescription}</span>
            </Link>
          })}
        </div>
      </section>}
    </article>

    <section className="final-cta">
      <h2>Stop losing work to a slow reply.</h2>
      <Link to="/signup" className="btn-primary-lg">Start free</Link>
    </section>

    <footer className="marketing-footer">
      <div><AppLogo /><p>Follow-up, CRM, booking and reputation for small businesses.</p></div>
      <nav aria-label="Footer">
        {MARKETING_PAGES.map((entry) => <Link key={entry.slug} to={marketingPath(entry)}>{entry.title}</Link>)}
      </nav>
      <p className="marketing-copyright">© {new Date().getFullYear()} LogicFlower</p>
    </footer>
  </div>
}
