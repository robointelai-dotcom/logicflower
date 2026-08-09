/**
 * Marketing landing pages.
 *
 * These exist to be found. A homepage cannot rank for "missed call text back
 * software" and "GoHighLevel alternative" and "CRM for electricians" at once —
 * search engines match a page to an intent, and one page has one intent.
 *
 * Content lives here rather than in the CMS because these pages describe what
 * the product does. If a claim here stops being true, the change belongs in a
 * commit alongside the code that made it untrue, not in a database somebody
 * edits separately.
 *
 * EVERY CLAIM MUST BE ONE WE CAN STAND BEHIND. Where a capability is waiting on
 * a platform approval, the page says so. A visitor who arrives from a search
 * for social posting and finds it cannot post is a refund and a bad review.
 */

export interface MarketingSection {
  heading: string
  body: string
  points?: string[]
}

export interface MarketingPage {
  slug: string
  kind: 'feature' | 'compare' | 'solution'
  /** Page title. Written for the search result, not for a brochure. */
  title: string
  metaTitle: string
  metaDescription: string
  /** The search intent this page is written for. */
  intent: string
  standfirst: string
  sections: MarketingSection[]
  /** Questions asked about this topic, answered plainly. Becomes FAQPage. */
  faqs: Array<{ question: string; answer: string }>
  /** Stated plainly where something is not yet available. */
  caveat?: string
  relatedSlugs?: string[]
}

export const MARKETING_PAGES: MarketingPage[] = [
  {
    slug: 'missed-call-text-back',
    kind: 'feature',
    title: 'Missed call text back',
    metaTitle: 'Missed Call Text Back Software for Small Businesses',
    metaDescription: 'When you cannot answer, they get a text within seconds. Stop losing work to the next name on their list.',
    intent: 'Somebody searching for a way to stop losing enquiries they could not answer.',
    standfirst:
      'You are on a job. The phone rings. By the time you call back they have booked somebody else. '
      + 'A text sent within seconds keeps the conversation alive.',
    sections: [
      {
        heading: 'What happens when you miss a call',
        body:
          'The caller gets a text within seconds saying you missed them and inviting a reply. When they reply, '
          + 'the conversation lands in your shared inbox and every automatic follow-up to that person stops.',
        points: [
          'Sent from your own number, through your own SMS account',
          'Only for genuine no-answers, never for a call you took',
          'Silent outside your working hours, in the caller\u2019s own timezone',
          'Never sent to anybody who has asked you to stop',
        ],
      },
      {
        heading: 'Why the first reply matters more than the best price',
        body:
          'Most enquiries go to whoever answers first. A business that replies in seconds wins work from one that '
          + 'replies tomorrow, and nobody can answer every call while also doing the job. This closes that gap '
          + 'without adding a person.',
      },
    ],
    faqs: [
      {
        question: 'Does it text every missed call?',
        answer: 'No. Only genuine no-answers, and never a number on your do-not-contact list. Calls you answered, and calls outside your working hours, are left alone.',
      },
      {
        question: 'What happens when they reply?',
        answer: 'The reply appears in your shared inbox and every automated follow-up to that person stops immediately, on every channel. Being chased after you have already answered is the fastest way to lose a customer.',
      },
      {
        question: 'Whose number does the text come from?',
        answer: 'Yours. You connect your own SMS account, so the message comes from the number they rang and you pay your provider directly for it.',
      },
    ],
    relatedSlugs: ['follow-up-automation', 'logicflower-vs-per-action-pricing'],
  },
  {
    slug: 'follow-up-automation',
    kind: 'feature',
    title: 'Follow-up that stops when they reply',
    metaTitle: 'Automated Follow-Up for Small Businesses — Stops on Reply',
    metaDescription: 'Multi-step follow-up by text and email that stops the moment somebody answers. No charge per message.',
    intent: 'Somebody looking for lead follow-up automation without per-action pricing.',
    standfirst:
      'Set the chase up once. It runs on every inquiry after that, and stops the moment the person replies.',
    sections: [
      {
        heading: 'How a sequence works',
        body:
          'A sequence is a series of messages with waits between them. Something immediate, something the next '
          + 'morning, something a few days later. Each step goes by text or email, in the customer\u2019s own '
          + 'working hours.',
        points: [
          'A three-day wait survives a restart — it is held in the database, not in memory',
          'Quiet hours in the customer\u2019s own timezone, correct across a clock change',
          'Nobody is ever messaged twice, even with two servers running',
          'Anyone who unsubscribes is skipped before every send, on every channel',
        ],
      },
      {
        heading: 'The part most tools get wrong',
        body:
          'A reply stops everything for that person, immediately, across every channel. You never have to remember '
          + 'to stop chasing somebody who has already answered — and being chased afterwards is the fastest way to '
          + 'lose the work you had already won.',
      },
      {
        heading: 'What it costs to run',
        body:
          'Nothing per action. You connect your own email and SMS accounts and pay those providers directly for '
          + 'the messages. There is no charge for the wait, the branch, or the step.',
      },
    ],
    faqs: [
      {
        question: 'What happens if somebody replies halfway through?',
        answer: 'Everything stops for that person straight away, on every channel. The conversation moves to your inbox for a human to answer.',
      },
      {
        question: 'Will it message people at night?',
        answer: 'No. Steps due inside your quiet hours wait until the window opens, in the contact\u2019s own timezone. They are held, never dropped.',
      },
      {
        question: 'Can a message be sent twice?',
        answer: 'No. Three independent safeguards prevent it, including a database constraint that holds even if two servers process the same step at the same instant.',
      },
    ],
    relatedSlugs: ['missed-call-text-back', 'logicflower-vs-per-action-pricing'],
  },
  {
    slug: 'crm-for-trades',
    kind: 'solution',
    title: 'A CRM for trades and home services',
    metaTitle: 'CRM for Trades — Plumbers, Electricians, Builders',
    metaDescription: 'Quote-to-job pipeline, follow-up that stops on reply, and a booking link. Set up for your trade in a minute.',
    intent: 'A tradesperson looking for something simpler than an enterprise CRM.',
    standfirst:
      'Inquiry, survey, quote, scheduled, done. Your work as a board, with the chasing handled for you.',
    sections: [
      {
        heading: 'Set up for your trade, not for a sales team',
        body:
          'Pick trades and home services when you sign up and your pipeline stages, custom fields, follow-up and '
          + 'inquiry form are written for you. Change any of it — it is a starting point, not a mould.',
        points: [
          'Stages that match how a job actually moves',
          'Site address, access notes and job type as real fields',
          'A speed-to-lead sequence already written',
          'An inquiry form to embed on your site',
        ],
      },
      {
        heading: 'Moving a card is what starts the chase',
        body:
          'Move a deal to Quoted and the follow-up begins. Move it to Won and it stops. That single join is the '
          + 'thing that makes a CRM worth keeping up to date, because it does something for you when you do.',
      },
    ],
    faqs: [
      {
        question: 'Do I have to set all this up myself?',
        answer: 'No. Choose your trade during setup and the pipeline, fields, follow-up and inquiry form are created for you as drafts. Read them, put them in your own words, and switch them on.',
      },
      {
        question: 'Will it work on a phone?',
        answer: 'Yes. The daily screen is built for exactly that — checked between jobs, on a phone, to see whether anything needs you.',
      },
    ],
    relatedSlugs: ['missed-call-text-back', 'follow-up-automation'],
  },
  {
    slug: 'logicflower-vs-per-action-pricing',
    kind: 'compare',
    title: 'Per-action pricing, and what it actually costs',
    metaTitle: 'Automation Without Per-Action Fees — A Cost Comparison',
    metaDescription: 'Most platforms bill for every workflow step. Work out what that costs you at your own volume.',
    intent: 'Somebody comparing platforms on cost, or unhappy with a bill that grows as they grow.',
    standfirst:
      'Most automation platforms charge for every step they take. Every text, every wait, every branch. '
      + 'Grow from 200 enquiries to 2,000 and the bill grows with it.',
    sections: [
      {
        heading: 'Where the money goes',
        body:
          'A per-action platform bills each step a workflow runs. A ten-step follow-up across 10,000 enquiries is '
          + '100,000 actions. At a penny each that is a four-figure monthly bill before a single message has been '
          + 'paid for.',
        points: [
          'The fee is for the software running the step, not for the message',
          'Message costs are separate and paid either way',
          'The bill rises with success, which is the wrong shape',
          'Businesses ration their own follow-up to control it',
        ],
      },
      {
        heading: 'What we do instead',
        body:
          'We do not charge per action. You connect your own email and SMS accounts and pay those providers '
          + 'directly for the messages you send. Follow up as thoroughly as the job deserves.',
      },
      {
        heading: 'Work it out on your own numbers',
        body:
          'The calculator on our homepage takes your inquiry volume, your number of steps, and the per-action rate '
          + 'your current platform actually charges. The arithmetic is shown rather than asserted — put your own '
          + 'figures in rather than taking ours.',
      },
    ],
    faqs: [
      {
        question: 'So it is free to send messages?',
        answer: 'No. Messages cost whatever your email or SMS provider charges, and you pay them directly. What you do not pay is a separate fee to us for each step the software takes.',
      },
      {
        question: 'Is there anything you do charge per unit for?',
        answer: 'No. Plans are priced by users and contacts. If that changes we will say so plainly rather than move it into a line item.',
      },
    ],
    relatedSlugs: ['follow-up-automation', 'missed-call-text-back'],
  },
]

export function marketingPageBySlug(slug: string): MarketingPage | undefined {
  return MARKETING_PAGES.find((page) => page.slug === slug)
}

/** Path for a page, grouped so the URL says what kind of thing it is. */
export function marketingPath(page: MarketingPage): string {
  const prefix = page.kind === 'compare' ? '/compare' : page.kind === 'solution' ? '/solutions' : '/features'
  return `${prefix}/${page.slug}`
}
