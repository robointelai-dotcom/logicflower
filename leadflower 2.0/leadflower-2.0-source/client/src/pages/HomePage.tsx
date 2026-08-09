import React from 'react'
import {
  ArrowRight, CalendarCheck, Check, Inbox, MessageSquareText,
  PhoneCall, Repeat2, Star, Users, Zap,
} from 'lucide-react'
import { Link } from '../router'
import { AppLogo } from '../components/ui'
import { useAuth } from '../auth/AuthContext'

/**
 * The public homepage.
 *
 * Two rules govern everything here.
 *
 * FIRST: every claim must be one we can stand behind. The engine, the CRM, the
 * inbox, booking and reviews are built and can be described plainly. Social
 * publishing and AI calling are gated on platform approvals we have not yet
 * been granted, so they are shown as coming rather than included — a visitor
 * who signs up expecting to post to Facebook and finds they cannot is a refund
 * and a bad review, and one honest label prevents it.
 *
 * SECOND: all meaning lives in real HTML text, never inside an image. The
 * diagrams below are built from DOM elements and inline SVG so a search engine
 * or an AI assistant reads the same words a person does. An ecosystem picture
 * with the value proposition baked into its pixels is invisible to both.
 */

/* ------------------------------------------------------------------ pieces */

function Pillar({ icon, eyebrow, title, children, status }: {
  icon: React.ReactNode
  eyebrow: string
  title: string
  children: React.ReactNode
  status?: 'live' | 'coming'
}) {
  return <article className="pillar">
    <span className="pillar-icon" aria-hidden="true">{icon}</span>
    <p className="pillar-eyebrow">{eyebrow}</p>
    <h3>{title}</h3>
    <p>{children}</p>
    {status === 'coming'
      ? <span className="pillar-tag pillar-tag-coming">Coming — awaiting platform approval</span>
      : <span className="pillar-tag">Available now</span>}
  </article>
}

/**
 * A flow diagram in DOM rather than an image.
 *
 * Every label is real text, so it is read by search engines, by screen readers
 * and by anyone with images disabled — none of which is true of a picture.
 */
function JourneyDiagram() {
  const steps = [
    { icon: <Users size={17} />, label: 'Lead arrives', note: 'Form, call or import' },
    { icon: <Zap size={17} />, label: 'Answered in seconds', note: 'Before they call anyone else' },
    { icon: <Repeat2 size={17} />, label: 'Followed up', note: 'Until they reply — then it stops' },
    { icon: <CalendarCheck size={17} />, label: 'Booked in', note: 'They pick a time that is free' },
    { icon: <Star size={17} />, label: 'Review asked for', note: 'Once, after the job' },
  ]
  return <ol className="journey" aria-label="What happens when a lead arrives">
    {steps.map((step, index) => <li key={step.label}>
      <span className="journey-node" aria-hidden="true">{step.icon}</span>
      <strong>{step.label}</strong>
      <span className="journey-note">{step.note}</span>
      {index < steps.length - 1 && <span className="journey-arrow" aria-hidden="true" />}
    </li>)}
  </ol>
}

/**
 * The savings calculator.
 *
 * Every input is the visitor's own, the per-action rate is theirs to change,
 * and the arithmetic is shown rather than asserted. A headline percentage with
 * no working behind it is a claim we would have to defend; a calculator the
 * visitor drives is a claim they make themselves.
 */
function SavingsCalculator() {
  const [leads, setLeads] = React.useState(500)
  const [steps, setSteps] = React.useState(6)
  const [rate, setRate] = React.useState(0.01)

  const actions = leads * steps
  const perActionCost = actions * rate
  const saved = perActionCost

  const money = (value: number) => value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  return <div className="calc">
    <div className="calc-inputs">
      <label>
        <span>Leads per month</span>
        <input type="range" min={50} max={10000} step={50} value={leads} onChange={(event) => setLeads(Number(event.target.value))} />
        <output>{leads.toLocaleString()}</output>
      </label>
      <label>
        <span>Follow-up steps per lead</span>
        <input type="range" min={1} max={20} value={steps} onChange={(event) => setSteps(Number(event.target.value))} />
        <output>{steps}</output>
      </label>
      <label>
        <span>Their charge per action</span>
        <input type="range" min={0.002} max={0.05} step={0.001} value={rate} onChange={(event) => setRate(Number(event.target.value))} />
        <output>${rate.toFixed(3)}</output>
      </label>
    </div>

    <div className="calc-result">
      <p className="calc-line">
        {leads.toLocaleString()} leads × {steps} steps = <strong>{actions.toLocaleString()} actions</strong>
      </p>
      <p className="calc-line">
        {actions.toLocaleString()} × ${rate.toFixed(3)} = <strong>{money(perActionCost)}</strong> in workflow fees
      </p>
      <p className="calc-headline">
        <span>You would not pay that here</span>
        <strong>{money(saved)}<span>/month</span></strong>
      </p>
      {/*
        Stated plainly rather than buried. The comparison is workflow-action
        fees only, and messages still cost whatever the provider charges.
      */}
      <p className="calc-note">
        This compares <b>per-action workflow fees only</b>. LogicFlower does not charge per action — you
        send through your own email and SMS provider and pay them directly for the messages themselves.
        Set the rate above to whatever your current platform actually charges you.
      </p>
    </div>
  </div>
}

/* -------------------------------------------------------------------- page */

export default function HomePage() {
  const { session } = useAuth()
  const primaryHref = session ? '/dashboard' : '/signup'
  const primaryLabel = session ? 'Open your workspace' : 'Start free'

  return <div className="marketing">
    {/*
      Structured data so search engines and AI assistants can extract what this
      is without inferring it from prose. Escaped for the one sequence that can
      terminate a script block early.
    */}
    <script type="application/ld+json" dangerouslySetInnerHTML={{
      __html: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'LogicFlower',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: 'Follow-up automation, micro-CRM, booking and reputation for small businesses, without per-action workflow fees.',
        offers: { '@type': 'Offer', category: 'SaaS' },
      }).replace(/</g, '\\u003c'),
    }} />

    <header className="marketing-nav">
      <Link to="/" className="marketing-brand"><AppLogo /></Link>
      <nav aria-label="Main">
        <a href="#pillars">Product</a>
        <a href="#ecosystem">Ecosystem</a>
        <a href="#how">How it works</a>
        <a href="#savings">Savings</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
        {/* An in-page anchor list with no route out of it strands the reader.
            Blog and Help are real destinations and belong here. */}
        <Link to="/blog">Blog</Link>
        <Link to="/help">Help</Link>
      </nav>
      <div className="marketing-nav-actions">
        <Link to="/login">Sign in</Link>
        <Link to={primaryHref} className="btn-primary-lg">{primaryLabel}</Link>
      </div>
    </header>

    {/* ---------------------------------------------------------- hero */}
    <section className="hero">
      <div className="hero-copy">
        <p className="hero-eyebrow">For small businesses that lose work by replying late</p>
        <h1>Every enquiry answered<br /><em>in seconds</em>, not tomorrow.</h1>
        <p className="hero-sub">
          LogicFlower chases every lead for you — by text and email — and stops the moment they reply.
          Add a simple CRM, a booking link and review collection, with <strong>no charge per action</strong>.
        </p>
        <div className="hero-actions">
          <Link to={primaryHref} className="btn-primary-lg">{primaryLabel}<ArrowRight size={17} /></Link>
          <a href="#savings" className="btn-ghost-lg">See what you would save</a>
        </div>
        <p className="hero-foot">No card required · Use your own email and SMS provider</p>
      </div>

      {/*
        The hero visual is DOM, not an image: a phone showing the moment that
        matters — a missed call turning into a booked job. It carries real text,
        so the story survives with images off.
      */}
      <div className="hero-visual" aria-hidden="true">
        <div className="phone">
          <div className="phone-notch" />
          <div className="phone-screen">
            <div className="chat-event"><PhoneCall size={13} /> Missed call · 4:58pm</div>
            <div className="chat-bubble chat-out">
              Sorry we missed your call. Reply here and we&rsquo;ll get straight back to you.
              <span className="chat-time">4:58pm</span>
            </div>
            <div className="chat-bubble chat-in">
              Hi, need a quote for a leaking tap
              <span className="chat-time">5:03pm</span>
            </div>
            <div className="chat-event chat-event-good"><Check size={13} /> Follow-up stopped — they replied</div>
            <div className="chat-bubble chat-out">
              Great — here are our next free slots.
              <span className="chat-time">5:04pm</span>
            </div>
            <div className="chat-event chat-event-good"><CalendarCheck size={13} /> Booked · Thu 10:30am</div>
          </div>
        </div>
        <div className="hero-orb hero-orb-a" />
        <div className="hero-orb hero-orb-b" />
      </div>
    </section>

    {/* ------------------------------------------------------ the problem */}
    <section className="band">
      <div className="band-inner">
        <h2>Why should software cost more just because you are winning more work?</h2>
        <p className="band-sub">
          Most automation platforms bill you for every step they take. Every text, every wait, every
          branch. Grow from 200 leads to 2,000 and the bill grows with it — for work the software was
          always going to do anyway.
        </p>
        <div className="contrast">
          <div className="contrast-card contrast-them">
            <h3>Charged per action</h3>
            <ul>
              <li>Every step in a follow-up is billed</li>
              <li>Costs rise as you grow</li>
              <li>You ration your own follow-up to save money</li>
            </ul>
          </div>
          <div className="contrast-card contrast-us">
            <h3>LogicFlower</h3>
            <ul>
              <li><Check size={15} />No charge per action</li>
              <li><Check size={15} />Your own email and SMS accounts</li>
              <li><Check size={15} />Follow up as thoroughly as the job deserves</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    {/* --------------------------------------------------------- pillars */}
    <section className="section" id="pillars">
      <div className="section-head">
        <p className="eyebrow">The ecosystem</p>
        <h2>Five things, working as one</h2>
        <p className="section-sub">Everything a small business needs between &ldquo;someone enquired&rdquo; and &ldquo;the job is done&rdquo;.</p>
      </div>
      <div className="pillar-grid">
        <Pillar icon={<Repeat2 size={20} />} eyebrow="Follow-up" title="Sequences that stop when they reply">
          Multi-step follow-up by text and email. A three-day wait survives a restart, quiet hours are
          kept in your customer&rsquo;s own timezone, and nobody is ever messaged twice.
        </Pillar>
        <Pillar icon={<Users size={20} />} eyebrow="Micro-CRM" title="A contact record you will actually keep up">
          Contacts, tags, pipelines and deals — sized for a small business, not an enterprise. Move a
          deal to &ldquo;Quoted&rdquo; and the chase starts on its own.
        </Pillar>
        <Pillar icon={<Inbox size={20} />} eyebrow="Inbox" title="One thread per person">
          Texts and emails in one conversation, in order. Reply from the same screen. A missed call
          gets a text back within seconds, before they ring the next name on the list.
        </Pillar>
        <Pillar icon={<CalendarCheck size={20} />} eyebrow="Booking" title="A link that shows real availability">
          Your hours, your appointment length, your buffers. Two people cannot take the same slot, and
          the confirmation and reminder run through your own follow-up.
        </Pillar>
        <Pillar icon={<Star size={20} />} eyebrow="Reputation" title="Reviews, asked for once">
          A request after the job — never twice to the same customer. Approve what goes public, then
          show it on your website with a widget that takes one line of code.
        </Pillar>
        <Pillar icon={<MessageSquareText size={20} />} eyebrow="Social & voice" title="Posting and AI calling" status="coming">
          The composer, calendar and calling safeguards are built. Publishing and dialling need
          approval from each platform and telephony provider, which we are working through — so we
          will not sell it as ready until it is.
        </Pillar>
      </div>
    </section>

    {/* ------------------------------------------------------- ecosystem map */}
    <section className="section section-tint" id="ecosystem">
      <div className="section-head">
        <p className="eyebrow">The whole picture</p>
        <h2>Four engines, one system</h2>
        <p className="section-sub">
          Each part hands work to the next, so a lead never falls between them.
        </p>
      </div>

      <figure className="ecosystem">
        {/*
          Two widths so a phone does not download a desktop-sized file. Lazy and
          async because this sits below the fold and must not delay the hero.
          The dimensions are declared to reserve the space and stop the page
          jumping as it loads.
        */}
        <img
          src="/ecosystem.jpg"
          srcSet="/ecosystem-640.jpg 640w, /ecosystem.jpg 1024w"
          sizes="(max-width: 900px) 100vw, 900px"
          width={1024}
          height={559}
          loading="lazy"
          decoding="async"
          alt="How the four engines connect: a lead arrives and enters follow-up by email and SMS; the CRM holds the contact, pipeline and history; booking and social handle appointments, reputation and posts; and voice handles calls."
        />
        <figcaption>How a lead moves through the system.</figcaption>
      </figure>

      {/*
        The meaning lives in this list, not in the picture above it. Text inside
        an image is invisible to search engines, to AI assistants and to anyone
        using a screen reader — so the diagram illustrates the point and these
        four items carry it.
      */}
      <ol className="ecosystem-key">
        <li>
          <span className="ecosystem-number">1</span>
          <strong>Follow-up engine</strong>
          <span>Email and SMS under your own provider, so there is no charge per action.</span>
        </li>
        <li>
          <span className="ecosystem-number">2</span>
          <strong>Micro-CRM</strong>
          <span>Contacts, tags, pipelines and deals — sized for a small business.</span>
        </li>
        <li>
          <span className="ecosystem-number">3</span>
          <strong>Booking and reputation</strong>
          <span>A booking link that shows real availability, and reviews on your website.</span>
        </li>
        <li>
          <span className="ecosystem-number">4</span>
          <strong>Voice</strong>
          <span>Missed-call text back today. AI calling once the safeguards are cleared.</span>
        </li>
      </ol>
    </section>

    {/* -------------------------------------------------------- how it works */}
    <section className="section" id="how">
      <div className="section-head">
        <p className="eyebrow">How it works</p>
        <h2>From enquiry to booked job</h2>
        <p className="section-sub">You set it up once. It runs on every lead after that.</p>
      </div>
      <JourneyDiagram />
    </section>

    {/* ----------------------------------------------------------- savings */}
    <section className="section" id="savings">
      <div className="section-head">
        <p className="eyebrow">Work it out yourself</p>
        <h2>What per-action fees are costing you</h2>
        <p className="section-sub">Move the sliders. The arithmetic is shown, not asserted.</p>
      </div>
      <SavingsCalculator />
    </section>

    {/* ------------------------------------------------------------ pricing */}
    <section className="section" id="pricing">
      <div className="section-head">
        <p className="eyebrow">Pricing</p>
        <h2>Priced by the size of your business, not how hard it works</h2>
        <p className="section-sub">
          No charge per message, per action or per automation. You connect your own email and SMS accounts
          and pay those providers directly for what you send.
        </p>
      </div>

      <div className="price-grid">
        {[
          {
            name: 'Solo', price: 'Free', note: 'While you set things up',
            points: ['1 user', 'Up to 250 contacts', 'Follow-up sequences', 'Shared inbox', 'Booking page', 'Review collection'],
          },
          {
            name: 'Business', price: '$49', note: 'per month', featured: true,
            points: ['Up to 5 users', 'Unlimited contacts', 'Everything in Solo', 'Missed-call text back', 'Pipelines and deals', 'Website review widget', 'Payment links'],
          },
          {
            name: 'Multi-location', price: 'Talk to us', note: 'Several sites or an agency',
            points: ['Unlimited users', 'Several workspaces', 'Manage clients from one console', 'Priority support'],
          },
        ].map((tier) => <article key={tier.name} className={tier.featured ? 'price-card featured' : 'price-card'}>
          {tier.featured && <span className="price-flag">Most businesses start here</span>}
          <h3>{tier.name}</h3>
          <p className="price-amount">{tier.price}<span>{tier.note}</span></p>
          <ul>{tier.points.map((point) => <li key={point}><Check size={14} />{point}</li>)}</ul>
          <Link to={primaryHref} className={tier.featured ? 'btn-primary-lg' : 'btn-ghost-lg'}>
            {tier.price === 'Talk to us' ? 'Get in touch' : primaryLabel}
          </Link>
        </article>)}
      </div>

      {/*
        Said plainly on the pricing page rather than discovered after paying.
        A customer who buys expecting to post to Facebook and cannot is a refund
        and a bad review; one honest paragraph prevents both.
      */}
      <p className="price-note">
        <strong>What you also pay for, and to whom.</strong> Messages are billed by your own email and SMS
        provider at their rates — we never mark them up. Social publishing and AI calling are not included in
        any plan yet: both are built but waiting on approval from the platforms and telephony providers
        involved, and we will not charge for them until they work.
      </p>
    </section>

    {/* --------------------------------------------------------------- faq */}
    <section className="section section-tint" id="faq">
      <div className="section-head">
        <p className="eyebrow">Questions</p>
        <h2>The things people ask first</h2>
      </div>
      <div className="faq">
        {[
          {
            q: 'How is this cheaper than platforms that charge per action?',
            a: 'They bill for each step a workflow takes. We do not charge per action at all — you connect your own email and SMS accounts and pay those providers directly for the messages. The calculator above shows the workflow fees you would stop paying; it does not include message costs, which you pay either way.',
          },
          {
            q: 'What happens when someone replies mid-sequence?',
            a: 'Everything stops for that person, on every channel, immediately. Being chased three more times after you have already answered is the fastest way to lose a customer, so it is handled automatically rather than left to you to remember.',
          },
          {
            q: 'Do I need to be technical?',
            a: 'No. Pick your trade when you sign up and you get a pipeline, follow-up sequences and an enquiry form already written for it. Change anything you like afterwards.',
          },
          {
            q: 'Can I really post to social media?',
            a: 'Not yet, and we will say so plainly rather than surprise you. The composer, calendar and scheduling are built, but publishing needs each platform to approve our application — Meta, LinkedIn, TikTok and the rest. Those take weeks to months and some can be refused. We will announce it when it is genuinely working.',
          },
          {
            q: 'Is the AI calling available?',
            a: 'Not yet. The parts that keep automated calling lawful are built and tested — calling hours in the customer\u2019s own timezone, do-not-call checks that block rather than assume, spoken disclosure, mid-call opt-out. The dialling itself needs a telephony provider connected, and we will not turn it on before that is done properly.',
          },
          {
            q: 'What happens to my data?',
            a: 'It stays yours. You can export everything, and delete it. Nobody from our team can open your workspace unless you approve it, that approval expires on its own, and you can see exactly who has access and withdraw it at any time.',
          },
        ].map((item) => <details key={item.q} className="faq-item">
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>)}
      </div>
    </section>

    {/* ---------------------------------------------------------------- cta */}
    <section className="final-cta">
      <h2>Stop losing work to a slow reply.</h2>
      <p>Set it up once. Every enquiry after that gets answered while they are still deciding.</p>
      <Link to={primaryHref} className="btn-primary-lg">{primaryLabel}<ArrowRight size={17} /></Link>
    </section>

    <footer className="marketing-footer">
      <div>
        <AppLogo />
        <p>Follow-up, CRM, booking and reputation for small businesses.</p>
      </div>
      <nav aria-label="Footer">
        {/* Internal links are how these pages get crawled at all. */}
        <Link to="/features/missed-call-text-back">Missed call text back</Link>
        <Link to="/features/follow-up-automation">Follow-up automation</Link>
        <Link to="/solutions/crm-for-trades">CRM for trades</Link>
        <Link to="/compare/logicflower-vs-per-action-pricing">Pricing comparison</Link>
        <Link to="/blog">Blog</Link>
        <Link to="/help">Help centre</Link>
        <Link to="/login">Sign in</Link>
        <Link to="/signup">Start free</Link>
        <Link to="/status">System status</Link>
      </nav>
      <p className="marketing-copyright">© {new Date().getFullYear()} LogicFlower</p>
    </footer>
  </div>
}
