import React from 'react'
import { ArrowLeft, BookOpen, HelpCircle, LifeBuoy, Search } from 'lucide-react'
import { Link, useParams } from '../router'
import { AppLogo } from '../components/ui'
import { articleBySlug, HELP_ARTICLES, HELP_CATEGORIES, searchArticles, type HelpArticle } from '../help/content'

/**
 * The help centre.
 *
 * Public: somebody evaluating the product, or locked out of their account,
 * should be able to read it. Nothing here is workspace-specific.
 *
 * Every article has the same headings in the same order, because a person
 * arriving in a hurry should not have to learn a new layout each time.
 */

function Chrome({ children }: { children: React.ReactNode }) {
  return <div className="marketing help-centre">
    <header className="marketing-nav">
      <Link to="/" className="marketing-brand"><AppLogo /></Link>
      <nav aria-label="Main"><Link to="/help">Help</Link><Link to="/blog">Blog</Link><Link to="/status">Status</Link></nav>
      <div className="marketing-nav-actions"><Link to="/login">Sign in</Link></div>
    </header>
    {children}
    <footer className="marketing-footer">
      <div><AppLogo /><p>Follow-up, CRM, booking and reputation for small businesses.</p></div>
      <p className="marketing-copyright">© {new Date().getFullYear()} LogicFlower</p>
    </footer>
  </div>
}

export function HelpCenterPage() {
  const [query, setQuery] = React.useState('')
  const results = React.useMemo(() => searchArticles(query), [query])

  React.useEffect(() => { document.title = 'Help — LogicFlower' }, [])

  return <Chrome>
    <section className="section help-head">
      <p className="eyebrow">Help centre</p>
      <h1>How everything works</h1>
      <p className="section-sub">Written for a business owner, not an engineer. If a word needs explaining, it is explained where it appears.</p>
      <label className="search-input help-search">
        <Search size={17} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search — try “activate”, “blocked” or “reply”"
          aria-label="Search help articles"
        />
      </label>
    </section>

    <section className="section">
      {/*
        Search covers problems and terminology as well as titles: somebody
        arriving here is usually quoting the thing that went wrong rather than
        the name of the feature.
      */}
      {query.trim().length >= 2 ? <>
        <p className="muted help-count">{results.length} article{results.length === 1 ? '' : 's'} matching “{query.trim()}”</p>
        <div className="help-grid">
          {results.map((article) => <Link key={article.slug} to={`/help/${article.slug}`} className="help-card">
            <strong>{article.title}</strong>
            <span className="muted">{article.summary}</span>
          </Link>)}
        </div>
        {!results.length && <p className="muted">Nothing matched. Try a shorter phrase, or browse the categories below.</p>}
      </> : HELP_CATEGORIES.map((category) => {
        const articles = HELP_ARTICLES.filter((article) => article.category === category.id)
        if (!articles.length) return null
        return <div key={category.id} className="help-category">
          <h2>{category.name}</h2>
          <p className="muted">{category.blurb}</p>
          <div className="help-grid">
            {articles.map((article) => <Link key={article.slug} to={`/help/${article.slug}`} className="help-card">
              <strong>{article.title}</strong>
              <span className="muted">{article.summary}</span>
            </Link>)}
          </div>
        </div>
      })}
    </section>

    <section className="section section-tint">
      <div className="help-support">
        <LifeBuoy size={24} />
        <div>
          <h2>Still stuck?</h2>
          <p className="muted">
            If a button is greyed out it is almost always waiting for something rather than broken — a sequence
            with no published steps, a pipeline with no stages, a booking page with no hours. The screen usually
            says which.
          </p>
        </div>
      </div>
    </section>
  </Chrome>
}

export default function HelpArticlePage() {
  const params = useParams()
  const article: HelpArticle | undefined = articleBySlug(params.slug ?? '')

  React.useEffect(() => {
    if (article) document.title = `${article.title} — LogicFlower help`
  }, [article])

  if (!article) return <Chrome>
    <section className="section article">
      <h1>Not found</h1>
      <p className="muted">That article does not exist.</p>
      <Link to="/help">Back to the help centre</Link>
    </section>
  </Chrome>

  const category = HELP_CATEGORIES.find((entry) => entry.id === article.category)

  return <Chrome>
    <article className="section article">
      <p className="back-link"><Link to="/help"><ArrowLeft size={13} /> Help centre</Link></p>
      <header className="article-head">
        <span className="eyebrow">{category?.name}</span>
        <h1>{article.title}</h1>
        <p className="article-standfirst">{article.summary}</p>
      </header>

      <div className="article-body">
        <h2>What it is</h2>
        <p>{article.whatItIs}</p>

        <h2>Why you would use it</h2>
        <p>{article.whyUseIt}</p>

        {article.example && <>
          <h2>An example</h2>
          <blockquote><p>{article.example}</p></blockquote>
        </>}

        <h2>How to do it</h2>
        <ol>{article.steps.map((step) => <li key={step}>{step}</li>)}</ol>

        {Boolean(article.terms?.length) && <>
          <h2>The words used here</h2>
          <dl className="help-terms">
            {article.terms!.map((term) => <div key={term.term}>
              <dt>{term.term}</dt>
              <dd>{term.meaning}</dd>
            </div>)}
          </dl>
        </>}

        {article.whatHappensNext && <>
          <h2>What happens next</h2>
          <p>{article.whatHappensNext}</p>
        </>}

        {Boolean(article.problems?.length) && <>
          <h2>If something goes wrong</h2>
          {article.problems!.map((problem) => <div key={problem.problem} className="help-problem">
            <strong>{problem.problem}</strong>
            <p>{problem.answer}</p>
          </div>)}
        </>}
      </div>

      {Boolean(article.related?.length) && <div className="help-related">
        <h2>Related</h2>
        <div className="help-grid">
          {article.related!.map((slug) => {
            const other = articleBySlug(slug)
            if (!other) return null
            return <Link key={slug} to={`/help/${slug}`} className="help-card">
              <strong>{other.title}</strong>
              <span className="muted">{other.summary}</span>
            </Link>
          })}
        </div>
      </div>}
    </article>
  </Chrome>
}

/**
 * The "?" link that sits on a product screen.
 *
 * Renders nothing when no article covers that screen, rather than a link to a
 * page that will not answer the question.
 */
export function HelpLink({ route }: { route: string }) {
  const article = HELP_ARTICLES.find((entry) => entry.route === route)
  if (!article) return null
  return <Link to={`/help/${article.slug}`} className="help-link" title={`Learn about this page: ${article.title}`}>
    <HelpCircle size={15} />
    <span>Learn about this page</span>
  </Link>
}

export { BookOpen }
