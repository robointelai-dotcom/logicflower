/**
 * Help center content.
 *
 * Shipped with the application rather than held in a database, deliberately.
 * Help that describes a version must travel with that version — a database
 * copy drifts the moment a screen changes, and stale instructions are worse
 * than none because somebody follows them.
 *
 * Every article follows the same shape, because a person arriving in a panic
 * should find the same headings in the same order every time: what it is, why
 * you would use it, an example, the steps, the words, what happens next, and
 * what usually goes wrong.
 *
 * Written for a business owner, not an engineer. If a sentence needs a
 * technical word, the word is explained where it appears.
 */

export interface HelpArticle {
  slug: string
  title: string
  category: string
  /** One line, shown in the index and in search results. */
  summary: string
  /** Route this article explains, for the "?" link on that screen. */
  route?: string
  whatItIs: string
  whyUseIt: string
  example?: string
  steps: string[]
  terms?: Array<{ term: string; meaning: string }>
  whatHappensNext?: string
  problems?: Array<{ problem: string; answer: string }>
  related?: string[]
}

export const HELP_CATEGORIES = [
  { id: 'getting-started', name: 'Getting started', blurb: 'Set the workspace up and understand what it does.' },
  { id: 'daily', name: 'Your daily work', blurb: 'The screens you will open most often.' },
  { id: 'automation', name: 'Follow-up and automation', blurb: 'Sequences, workflows and what triggers them.' },
  { id: 'booking', name: 'Booking', blurb: 'Availability, links and appointments.' },
  { id: 'reputation', name: 'Social and reviews', blurb: 'Posting, review collection and your widget.' },
  { id: 'calling', name: 'AI calling', blurb: 'Voice agents and the rules that govern them.' },
  { id: 'privacy', name: 'Access and privacy', blurb: 'Who can see your data, and how to stop them.' },
  { id: 'agency', name: 'For agencies', blurb: 'Managing several client businesses.' },
]

export const HELP_ARTICLES: HelpArticle[] = [
  /* ------------------------------------------------------ getting started */
  {
    slug: 'what-is-logicflower',
    title: 'What this does, in one page',
    category: 'getting-started',
    summary: 'The short version: it answers enquiries fast and stops when someone replies.',
    whatItIs:
      'A system that answers every inquiry quickly, keeps following up until the person replies, and stops the '
      + 'moment they do. Everything else — the contact record, the pipeline, the booking link, the reviews — '
      + 'exists to support that.',
    whyUseIt:
      'Most enquiries go to whoever replies first. A business that answers in minutes wins work from one that '
      + 'answers tomorrow, and nobody can reply in minutes all day while also doing the job.',
    example:
      'Someone rings while you are on a job. They get a text within seconds. They reply asking for a quote. Every '
      + 'other automatic message stops immediately, and the conversation is waiting for you in the inbox.',
    steps: [
      'Run Setup and pick the trade closest to your business.',
      'Read the follow-up it wrote for you and put it in your own words.',
      'Add or import your contacts.',
      'Publish a booking link and open it yourself to see what a customer sees.',
      'Turn the follow-up on.',
    ],
    whatHappensNext:
      'Nothing sends until that last step. Sequences, forms and voice agents are all created as drafts on '
      + 'purpose — software that started messaging your customers the moment you signed up would be indefensible.',
    related: ['setting-up-your-workspace', 'what-is-a-sequence'],
  },
  {
    slug: 'setting-up-your-workspace',
    title: 'Setting up your workspace',
    category: 'getting-started',
    route: '/setup',
    summary: 'One choice creates your pipeline, fields, follow-up and inquiry form.',
    whatItIs:
      'A short wizard. You pick the trade closest to your business and it writes a pipeline with sensible '
      + 'stages, the extra fields your trade needs, a couple of follow-up sequences and an inquiry form.',
    whyUseIt:
      'A brand-new workspace is empty, and several buttons are correctly disabled until it has something to work '
      + 'with. Skipping this is the single most common reason the application looks broken when it is not.',
    example:
      'A plumbing business picks Trades and gets stages of New inquiry, Survey booked, Quoted, Scheduled, '
      + 'Completed — plus a speed-to-lead sequence already written.',
    steps: [
      'Open Setup from the Today screen or go to /setup.',
      'Choose the closest match. It does not have to be exact.',
      'Press Set up my workspace.',
      'Read the summary of what was created.',
      'Read the notes attached to your pack before switching anything on.',
    ],
    terms: [
      { term: 'Starter pack', meaning: 'The set of stages, fields, sequences and forms written for a trade. A starting point, not a mould.' },
      { term: 'Draft', meaning: 'Created but not switched on. Nothing is sent to anyone while something is a draft.' },
    ],
    whatHappensNext:
      'Everything it created is ordinary and editable. Change any of it. The sequences in particular were '
      + 'written for your trade rather than for your business, so read them in your own voice first.',
    problems: [
      { problem: 'I skipped it and now New Deal is greyed out.', answer: 'You have no pipeline, so there is nowhere to put a deal. Run Setup, or create a pipeline from the Pipeline screen.' },
      { problem: 'I picked the wrong trade.', answer: 'Nothing is locked. Edit the stages, rewrite the sequences, delete what you do not want.' },
    ],
    related: ['what-is-a-pipeline', 'what-is-a-sequence'],
  },

  /* --------------------------------------------------------------- daily */
  {
    slug: 'today-screen',
    title: 'The Today screen',
    category: 'daily',
    route: '/dashboard',
    summary: 'What needs a person, and what is running without one.',
    whatItIs:
      'The first screen you see. It answers two questions and deliberately refuses a third: what needs you, and '
      + 'what is running unattended. It does not show how many messages you sent, because that is not something '
      + 'you can act on.',
    whyUseIt:
      'Opened between jobs, it tells you in one glance whether anything needs you. If it says All clear, it '
      + 'genuinely is.',
    steps: [
      'Look at the working-hours strip along the top. Shaded means nothing will send; the marker is now.',
      'Read Needs you. Every line is a link to the thing that resolves it.',
      'Glance at Running on its own to confirm follow-up is still moving.',
    ],
    terms: [
      { term: 'Working hours', meaning: 'When the system is allowed to send. Outside them, work waits rather than being dropped.' },
      { term: 'Unknown outcome', meaning: 'A message where nobody can establish whether it was delivered. See the article on that.' },
    ],
    problems: [
      { problem: 'It says All clear but the workspace is empty.', answer: 'It offers Set up my workspace in that case. If you have skipped setup, start there.' },
    ],
    related: ['unknown-send-outcomes', 'setting-up-your-workspace'],
  },
  {
    slug: 'inbox-and-replies',
    title: 'The inbox, and what a reply does',
    category: 'daily',
    route: '/inbox',
    summary: 'One thread per person — and a reply stops all follow-up to them.',
    whatItIs:
      'One conversation per person across text and email together. If somebody texts, then emails, then texts '
      + 'again, that is a single thread in order.',
    whyUseIt:
      'Because the alternative is checking two places and losing the thread of who said what.',
    steps: [
      'Pick a conversation on the left.',
      'Read the history.',
      'Type a reply and choose SMS or email.',
    ],
    whatHappensNext:
      'The most important behaviour in the product: an inbound reply stops every sequence that person is in, '
      + 'immediately, on every channel. You never have to remember to stop chasing somebody who has answered.',
    problems: [
      { problem: 'No conversations appear.', answer: 'Replies arrive here once you have contacts and a running sequence. Connect your email or SMS provider in Settings first.' },
      { problem: 'A message says it could not be decrypted.', answer: 'Message content is encrypted at rest. If it will not open, the encryption key has changed. Contact support.' },
    ],
    related: ['what-is-a-sequence', 'unknown-send-outcomes'],
  },
  {
    slug: 'contacts-and-fields',
    title: 'Adding a contact, and every field on it',
    category: 'daily',
    route: '/contacts',
    summary: 'What a contact record holds, and why an email or phone is required.',
    whatItIs:
      'Everyone your business can reach. The form shows the essentials; the rest is behind Add address, status '
      + 'and more.',
    whyUseIt:
      'Nothing else works without contacts. Sequences, booking and reviews all act on people.',
    example:
      'A joiner records a customer with a site address, a second phone for the site foreman, and a lead score of '
      + '80 because the job is worth having.',
    steps: [
      'Press New contact.',
      'Enter a name, and either an email address or a phone number.',
      'Open Add address, status and more for address lines, city, region, postcode, country, job title, second '
      + 'phone, preferred contact method, referred by and lead score.',
      'Save.',
    ],
    terms: [
      { term: 'Lead score', meaning: 'A number from 0 to 100 that you set. Deliberately manual — an automatic score would be a guess presented as a fact, and every business weighs its own signals differently.' },
      { term: 'Lifecycle status', meaning: 'Where somebody is in your relationship: lead, engaged, qualified, customer, churned, unqualified.' },
      { term: 'Custom field', meaning: 'A field you define yourself, with a real type. A date behaves as a date.' },
    ],
    problems: [
      { problem: 'It will not let me save without an email or phone.', answer: 'A contact with neither can never be sent to, and every sequence would exit on its first step. One or the other is required.' },
      { problem: 'I imported a spreadsheet and some rows were skipped.', answer: 'The preview shows why: no email or phone, a duplicate within the file, or an invalid value. Fix the file and import again.' },
    ],
    related: ['using-tags', 'importing-contacts'],
  },
  {
    slug: 'using-tags',
    title: 'Tags, and how they drive automation',
    category: 'daily',
    summary: 'A tag is a label that can start follow-up, set a status or raise a task.',
    whatItIs:
      'A short label on a contact — vip, needs-quote, no-show. Informal in the way businesses actually work, and '
      + 'the most common way automation is triggered.',
    whyUseIt:
      'Because it is faster than filling in a form. Tagging somebody needs-quote can start a chase sequence '
      + 'without you configuring anything else.',
    example:
      'A salon tags a client no-show. That tag starts a short sequence offering to rebook, and raises a task for '
      + 'reception to ring them.',
    steps: [
      'Open a contact.',
      'Type a tag in the Tags card and press Add.',
      'Remove one with the small cross beside it.',
    ],
    terms: [
      { term: 'Tag rule', meaning: 'A setting that says "when this tag is added, do that" — enrol a sequence, set a status, raise a task.' },
    ],
    whatHappensNext:
      'Tags are matched loosely on purpose: VIP, vip and V.I.P. are treated as one tag. That is what stops a rule '
      + 'you wrote months ago from quietly failing because a colleague typed it differently.',
    problems: [
      { problem: 'I added a tag and nothing happened.', answer: 'A tag only does something if a rule or a workflow is listening for it. Adding one is not automatic on its own.' },
      { problem: 'The same tag was added twice and nothing fired the second time.', answer: 'Correct, and deliberate. Only real changes fire rules — otherwise a nightly sync would re-enrol everybody every night.' },
    ],
    related: ['contacts-and-fields', 'workflows-explained'],
  },
  {
    slug: 'importing-contacts',
    title: 'Importing a spreadsheet',
    category: 'daily',
    summary: 'Map the columns, preview every row, then approve.',
    whatItIs: 'A three-step import: suggest a mapping, preview what will happen, apply it.',
    whyUseIt: 'To bring an existing customer list in without typing it.',
    steps: [
      'Prepare a CSV with a header row.',
      'The column mapping is suggested — check it, since a wrong guess writes the wrong thing across every row.',
      'Read the preview: how many will be created, updated and skipped, and why.',
      'Apply.',
    ],
    whatHappensNext:
      'Imported contacts carry no consent record. A list from a spreadsheet is not permission to contact the '
      + 'people on it, and the system will not pretend otherwise. Make sure you have a lawful basis before you '
      + 'start sending.',
    problems: [
      { problem: 'Duplicate rows in my file.', answer: 'Caught during preview. The first row wins; later ones are skipped rather than silently overwriting.' },
      { problem: 'A column was not mapped.', answer: 'Unrecognised columns are left alone rather than guessed at. Map it by hand if you need it.' },
    ],
    related: ['contacts-and-fields'],
  },
  {
    slug: 'what-is-a-pipeline',
    title: 'Pipelines, stages and deals',
    category: 'daily',
    route: '/pipeline',
    summary: 'Your work as a board — and moving a card is what starts follow-up.',
    whatItIs:
      'A board. Each column is a stage of your work; each card is a job or a sale.',
    whyUseIt:
      'Because moving a card is the easiest way to trigger the right follow-up at the right moment.',
    example:
      'An electrician moves a deal to Quoted. That starts a three-step chase over a week. The customer replies, '
      + 'so it stops. The deal moves to Scheduled and a booking confirmation goes out.',
    steps: [
      'Press Edit stages to add, rename or reorder them, and mark which mean won and lost.',
      'Press New deal, choose a contact, give it a title and value.',
      'Drag cards between columns as work progresses.',
    ],
    terms: [
      { term: 'Stage', meaning: 'A column. Moving a deal into one can start or stop a sequence and raise a task.' },
      { term: 'Won / lost', meaning: 'Stages marked as an outcome. Deals in them are closed rather than in progress.' },
    ],
    whatHappensNext:
      'Renaming a stage keeps every deal in it and keeps any automation attached to it working. The name is a '
      + 'label; the stage itself does not change identity.',
    problems: [
      { problem: 'New Deal is greyed out.', answer: 'No pipeline exists yet. Run Setup, or create one from this screen.' },
      { problem: 'I cannot delete a stage.', answer: 'A stage still holding deals cannot be removed. Move them first.' },
    ],
    related: ['setting-up-your-workspace', 'what-is-a-sequence'],
  },

  /* --------------------------------------------------------- automation */
  {
    slug: 'what-is-a-sequence',
    title: 'What a sequence is',
    category: 'automation',
    route: '/sequences',
    summary: 'Timed follow-up that stops the moment someone replies.',
    whatItIs:
      'A series of messages with waits between them. Step one might send straight away, step two the next day, '
      + 'step three three days later.',
    whyUseIt:
      'Because most work is won by following up, and nobody follows up reliably by hand while also doing the job.',
    example:
      'New inquiry arrives. Immediate text acknowledging it. Next morning, an email with a price guide. Three '
      + 'days later, a short "still interested?" text. Any reply stops all of it.',
    steps: [
      'Open Sequences and press New sequence.',
      'Open it and add steps.',
      'Publish the steps.',
      'Return to the list and press Activate.',
    ],
    terms: [
      { term: 'Step', meaning: 'One wait plus one message.' },
      { term: 'Published version', meaning: 'A frozen copy of the steps. Editing creates a new one; anybody part-way through the old one finishes on it.' },
      { term: 'Quiet hours', meaning: 'A window when nothing sends. Work waits rather than being dropped.' },
    ],
    problems: [
      { problem: 'Activate is greyed out.', answer: 'The sequence has no published steps. Open it, add some, publish. The button is doing its job.' },
      { problem: 'I edited a live sequence. What happens to people already in it?', answer: 'They finish on the version they started. That is what stops an edit changing a message somebody is about to receive.' },
    ],
    related: ['writing-sequence-steps', 'unknown-send-outcomes'],
  },
  {
    slug: 'writing-sequence-steps',
    title: 'Writing the steps',
    category: 'automation',
    route: '/sequences/:id',
    summary: 'Channel, wait and message per step, plus quiet hours.',
    whatItIs: 'The editor where you write what actually gets sent.',
    whyUseIt: 'Nothing sends until steps exist and are published.',
    steps: [
      'Press Add email step or Add SMS step.',
      'Choose when: straight away, after a wait, or at a time of day in the customer\u2019s own timezone.',
      'Write the subject and message. Use the Insert buttons for first name and company.',
      'Set quiet hours in the panel on the right.',
      'Press Publish version.',
    ],
    terms: [
      { term: 'Merge field', meaning: 'A placeholder like {{contact.firstName}} replaced with the real value when sending. If it is empty, nothing is shown rather than the placeholder.' },
    ],
    whatHappensNext:
      'A three-day wait is held in the database, not in memory. Restarting the server or deploying does not lose '
      + 'it. The message still goes at the right minute.',
    problems: [
      { problem: 'It will not let me publish.', answer: 'The issues are listed above the steps as you type. Usually an empty message or a missing subject on an email step.' },
      { problem: 'SMS steps have no subject field.', answer: 'Text messages do not have subjects. Switching a step to SMS removes it.' },
    ],
    related: ['what-is-a-sequence'],
  },
  {
    slug: 'unknown-send-outcomes',
    title: 'Sends with an unknown outcome',
    category: 'automation',
    summary: 'What they mean, and why you must not simply retry them.',
    whatItIs:
      'A message where the system started sending but could not establish what happened — usually because the '
      + 'connection dropped part-way.',
    whyUseIt:
      'You need to understand this one, because handling it wrongly sends somebody the same message twice.',
    example:
      'A text was handed to the provider, then the connection failed before a confirmation came back. It may have '
      + 'gone. It may not.',
    steps: [
      'Open the sequence list and read Scheduler health.',
      'Check with your email or SMS provider whether the message actually went.',
      'Only then decide whether to send again.',
    ],
    whatHappensNext:
      'These are shown separately from failed sends on purpose. A failure can safely be retried. An unknown '
      + 'outcome cannot — the system will not retry one automatically, and neither should you without checking.',
    problems: [
      { problem: 'Can I just retry them all?', answer: 'No. Some may already have been delivered, and retrying sends them twice.' },
    ],
    related: ['today-screen', 'what-is-a-sequence'],
  },
  {
    slug: 'workflows-explained',
    title: 'Workflows: triggers, conditions and actions',
    category: 'automation',
    route: '/workflows',
    summary: 'The visual builder, for automation more complex than a straight sequence.',
    whatItIs:
      'A graph you draw. Something happens (a trigger), something is checked (a condition), things follow '
      + '(actions).',
    whyUseIt:
      'A sequence sends messages on a timer. A workflow can branch — do this for a customer with a tag, that for '
      + 'one without.',
    example:
      'Tag added "solar-interest" → has tag "existing-customer"? → if yes, enrol in the upgrade sequence; if no, '
      + 'move the deal to New inquiry and raise a task.',
    steps: [
      'Open Workflows and create one.',
      'Drag a trigger onto the canvas.',
      'Add conditions and actions.',
      'Dry run it.',
      'Publish.',
    ],
    terms: [
      { term: 'Trigger', meaning: 'What starts it — a contact created, a tag added, a deal moved, a form submitted.' },
      { term: 'Dry run', meaning: 'Shows what would happen without doing it.' },
    ],
    problems: [
      { problem: 'Some nodes warn about a per-action charge.', answer: 'Those route through an external CRM and cost money each time. Their local equivalents do the same job at no per-action cost — prefer them unless you specifically need the external system updated.' },
      { problem: 'Could two workflows trigger each other forever?', answer: 'No. Chains stop automatically after a few links, and a warning is logged.' },
    ],
    related: ['using-tags', 'what-is-a-sequence'],
  },

  /* ------------------------------------------------------------ booking */
  {
    slug: 'booking-pages',
    title: 'Booking pages and availability',
    category: 'booking',
    route: '/booking',
    summary: 'A link customers use to pick a time that is genuinely free.',
    whatItIs:
      'A public page showing your real availability, worked out from your hours and whatever is already in the '
      + 'calendar.',
    whyUseIt: 'It removes the back-and-forth of agreeing a time by message.',
    steps: [
      'Press New booking page.',
      'Set your days and hours, appointment length, the gap you want after each one, the shortest notice you '
      + 'will accept, and how far ahead people may book.',
      'Press Publish, then Copy link.',
      'Open the link yourself in a private window to see what a customer sees.',
    ],
    terms: [
      { term: 'Buffer', meaning: 'Time held clear after an appointment. It does not shorten the appointment — a 30-minute booking with a 15-minute buffer gives the customer 30 minutes and holds 45 of your calendar.' },
      { term: 'Shortest notice', meaning: 'How far in advance somebody must book. Stops a booking twenty minutes from now.' },
      { term: 'Horizon', meaning: 'How far ahead the calendar is open.' },
    ],
    whatHappensNext:
      'Two people cannot take the same slot, even booking at the same instant. Your hours are in your timezone; '
      + 'a visitor sees them converted to theirs, and it stays correct across a clock change.',
    problems: [
      { problem: 'Publishing is refused.', answer: 'The settings would show an empty calendar — usually a window shorter than one appointment, or a notice period longer than the horizon.' },
      { problem: 'I cannot change the address of a published page.', answer: 'Customers may already hold that link. Duplicate the page to get a new address.' },
      { problem: 'Can I delete a page with bookings on it?', answer: 'Yes, and the appointments survive. A page is a form, not a commitment.' },
    ],
    related: ['what-is-a-sequence'],
  },

  /* --------------------------------------------------------- reputation */
  {
    slug: 'collecting-reviews',
    title: 'Asking for reviews',
    category: 'reputation',
    route: '/social',
    summary: 'One request per customer, moderated by you, shown on your website.',
    whatItIs:
      'A request sent by text or email after a job, a page for them to reply on, and a widget that shows the '
      + 'approved ones on your site.',
    whyUseIt: 'Reviews are what a stranger checks before ringing you.',
    steps: [
      'Open Social and find Reviews.',
      'Request a review from a contact.',
      'When one arrives, read it and choose Publish or Hide.',
      'Reply to it if you want to.',
      'Copy the widget code onto your website.',
    ],
    whatHappensNext:
      'Only one request goes to each customer — the system will not let you ask twice, because that is the '
      + 'fastest way to annoy somebody who has already decided not to.',
    problems: [
      { problem: 'A review has not appeared on my website.', answer: 'Nothing is public until you approve it. Check its state on the Reviews list.' },
      { problem: 'Can I reply to a Google review here?', answer: 'Not yet. Only reviews collected through your own request link can be replied to from here.' },
    ],
    related: ['social-posting'],
  },
  {
    slug: 'social-posting',
    title: 'Social posting, and why it is not live yet',
    category: 'reputation',
    // No route: the /social screen's contextual link points at review
    // collection, which is the half that actually works today. Two articles
    // claiming one screen would make the "?" link ambiguous.

    summary: 'You can compose and schedule now. Publishing waits on platform approval.',
    whatItIs: 'A composer and calendar for posts across several platforms.',
    whyUseIt: 'To keep a page alive without logging into five different apps.',
    steps: [
      'Write a post and choose which accounts it goes to.',
      'Schedule it.',
      'Check the platform status list to see what is actually approved.',
    ],
    whatHappensNext:
      'Posts will not publish until each platform approves the application. Meta, LinkedIn, TikTok and Pinterest '
      + 'each review separately, taking weeks to months, and some can refuse. The screen shows the real status '
      + 'and will not claim otherwise.',
    problems: [
      { problem: 'Why does it say "awaiting platform approval"?', answer: 'Because that is true. Composing works; publishing needs the platform\u2019s permission, which cannot be shortened by anything in this software.' },
      { problem: 'What about Google Business Profile?', answer: 'Not covered by the current posting service at all. It needs a separate access request, and for a local business it is arguably the most valuable of the lot.' },
    ],
    related: ['collecting-reviews'],
  },

  /* ------------------------------------------------------------ calling */
  {
    slug: 'ai-calling-safety',
    title: 'AI calling, and the rules it follows',
    category: 'calling',
    route: '/voice',
    summary: 'Everything that keeps calling lawful is built. The dialling is not connected yet.',
    whatItIs:
      'Voice agents that answer or place calls, wrapped in checks that run before any call is placed.',
    whyUseIt:
      'Read this before enabling anything. Automated calling is the most regulated thing in the product, and the '
      + 'rules differ by country and sometimes by state.',
    steps: [
      'Check the calling policy: permitted hours, days and jurisdiction.',
      'Create an agent and write its script.',
      'Leave rehearsal mode on and watch what it would do.',
      'Get legal advice for every market you will call into before turning rehearsal off.',
    ],
    terms: [
      { term: 'Rehearsal mode', meaning: 'Every check runs against your real contacts and records what it would have done, without ringing anybody. On by default.' },
      { term: 'Do-not-call registry', meaning: 'A list of numbers that must not be called. With none connected, every call is blocked.' },
      { term: 'Restricted topic', meaning: 'Something the agent must never answer on, with the exact words to say instead.' },
    ],
    whatHappensNext:
      'Calling hours default to a conservative window. Widening them requires somebody to record that they took '
      + 'legal advice — software does not get to decide that 7am calls are acceptable.',
    problems: [
      { problem: 'Every call says blocked.', answer: 'Expected. With no do-not-call registry connected, nothing dials. A check that cannot verify a number must not report it as clear.' },
      { problem: 'Why must I list restricted topics?', answer: 'Because if a caller asks something your instructions do not cover, the agent does not go quiet — it improvises an answer. For a regulated trade that is a liability, so give it words to decline with.' },
    ],
    related: ['writing-a-voice-agent'],
  },
  {
    slug: 'writing-a-voice-agent',
    title: 'Writing a voice agent',
    category: 'calling',
    route: '/voice/agents/:id',
    summary: 'Brief it as you would a new member of staff.',
    whatItIs: 'The editor where you set an agent\u2019s style, purpose, knowledge and limits.',
    whyUseIt: 'An agent with a thin brief improvises. A well-briefed one declines politely.',
    steps: [
      'Choose whether it answers or places calls.',
      'Choose a style. Only the sales style follows a step-by-step script.',
      'Set tone, goal and background.',
      'Write the instructions: services, prices, FAQs, rules.',
      'Add restricted topics with the words to say instead.',
      'Write the automated-caller disclosure. It cannot be switched off.',
      'Publish.',
    ],
    problems: [
      { problem: 'The script box has disappeared.', answer: 'Only the sales style follows a script. For the others, put that guidance in the instructions where it will actually be used.' },
      { problem: 'It will not let me enable recording.', answer: 'Recording needs an announcement, because whether it is lawful at all depends on consent rules the software cannot judge for you.' },
    ],
    related: ['ai-calling-safety'],
  },

  /* ------------------------------------------------------------ privacy */
  {
    slug: 'who-can-see-your-data',
    title: 'Who can see your data',
    category: 'privacy',
    route: '/access-ledger',
    summary: 'Nobody outside your business, unless you approve it — and it expires.',
    whatItIs:
      'A list of everyone outside your business who can currently open your workspace, why, until when, and how '
      + 'many requests they have made.',
    whyUseIt: 'Because it is your customers\u2019 details, and you should be able to check.',
    steps: [
      'Open Who has access.',
      'Approve or decline any pending request.',
      'Press Withdraw to end an active one immediately.',
      'Read the history of past requests.',
    ],
    whatHappensNext:
      'Support cannot open your workspace unless you approve it, every approval expires on its own, and you can '
      + 'withdraw it mid-session. This screen is readable by everyone in your business, not only the owner.',
    problems: [
      { problem: 'Support asked for access. Should I approve it?', answer: 'Only if you asked for help and the reason matches. Approvals are short by default, and you can end one at any time.' },
    ],
    related: ['agency-access'],
  },
  {
    slug: 'agency-access',
    title: 'If an agency manages your workspace',
    category: 'privacy',
    summary: 'You decide whether they can walk in or must ask each time.',
    whatItIs:
      'A setting on your workspace controlling how the agency that manages you gets in.',
    whyUseIt: 'It is your data. You should choose.',
    steps: [
      'Open Who has access.',
      'Choose standing access or require approval each time.',
      'Change it whenever you like.',
    ],
    terms: [
      { term: 'Standing access', meaning: 'They can open your workspace any time. The default when they set it up for you.' },
      { term: 'On request', meaning: 'They must ask, you approve, and it expires — exactly as support access does.' },
    ],
    whatHappensNext:
      'Either way, every visit is recorded and visible to you. The only difference is whether permission is asked '
      + 'each time or given once and revocable.',
    related: ['who-can-see-your-data'],
  },

  /* ------------------------------------------------------------- agency */
  {
    slug: 'managing-clients',
    title: 'Managing client businesses',
    category: 'agency',
    route: '/clients',
    summary: 'A triage board sorted by need, not alphabetically.',
    whatItIs:
      'Your client list, with those needing attention at the top and the rest collapsed into one line.',
    whyUseIt:
      'With eighteen clients, an alphabetical grid means scanning eighteen cards to find the two that matter, '
      + 'every time.',
    steps: [
      'Read the summary line across all clients.',
      'Work through Needs you. Each entry says why.',
      'Press Open to work inside a client workspace.',
      'Press New client to provision one. They never see a signup form.',
    ],
    whatHappensNext:
      'When you open a client, everything you do is scoped to that client and recorded against your name. The '
      + 'client can see it.',
    problems: [
      { problem: 'A client shows Request access instead of Open.', answer: 'They have chosen to approve each visit. Ask, and they will see the request.' },
    ],
    related: ['agency-access'],
  },
]

export function articleBySlug(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.slug === slug)
}

/** The article explaining a given screen, for its contextual help link. */
export function articleForRoute(route: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.route === route)
}

/**
 * Search across every field a person might remember a phrase from.
 *
 * Deliberately searches problems and terminology as well as titles: somebody
 * arriving at the help center is usually quoting the thing that went wrong, not
 * the name of the feature.
 */
export function searchArticles(query: string): HelpArticle[] {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle.length < 2) return []
  return HELP_ARTICLES.filter((article) => [
    article.title, article.summary, article.whatItIs, article.whyUseIt, article.example ?? '',
    ...article.steps,
    ...(article.terms ?? []).flatMap((term) => [term.term, term.meaning]),
    ...(article.problems ?? []).flatMap((problem) => [problem.problem, problem.answer]),
  ].join(' ').toLowerCase().includes(needle))
}
