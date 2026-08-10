import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { briefFromWork, canPublishDraft, MAX_ARTICLES_PER_MONTH } from '../src/services/visibility/articleDrafts'
import { UnconfiguredSearchConsoleProvider, GoogleSearchConsoleProvider, searchConsoleProvider } from '../src/services/visibility/searchConsole'

describe('article drafting refuses rather than producing filler', () => {
  const oneJob = { jobs: [{ title: 'Boiler replacement', place: 'Adyar', valueMinorUnits: 340_000 }], questions: [], reviews: [] }

  it('refuses when there is no completed work', () => {
    // The refusal IS the safety mechanism. An article about nothing in
    // particular is the thin content Google's scaled-content policy targets,
    // and the risk sits on the customer's domain.
    const result = briefFromWork({ sources: { jobs: [], questions: [], reviews: [] }, publishedThisMonth: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/nothing worth writing/i)
  })

  it('refuses once the monthly cap is reached', () => {
    const result = briefFromWork({ sources: oneJob, publishedThisMonth: MAX_ARTICLES_PER_MONTH })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/already published/i)
  })

  it('caps at a rate that does not look like content farming', () => {
    expect(MAX_ARTICLES_PER_MONTH).toBeLessThanOrEqual(2)
  })

  it('builds the brief from the real job, not a template', () => {
    const result = briefFromWork({ sources: oneJob, publishedThisMonth: 0 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.suggestedTitle).toContain('Adyar')
      expect(result.points.some((point) => point.includes('Adyar'))).toBe(true)
      expect(result.points.some((point) => /changed the quote/i.test(point))).toBe(true)
    }
  })

  it('pulls in questions people actually asked more than once', () => {
    const result = briefFromWork({
      sources: {
        ...oneJob,
        questions: [{ question: 'Do you work Sundays?', askedCount: 5 }, { question: 'One-off?', askedCount: 1 }],
      },
      publishedThisMonth: 0,
    })
    if (result.ok) {
      expect(result.questions).toContain('Do you work Sundays?')
      expect(result.questions).not.toContain('One-off?')
    }
  })

  it('requires a named reviewer for trades that give advice', () => {
    const dentist = briefFromWork({ sources: oneJob, businessType: 'Dentist', publishedThisMonth: 0 })
    const plumber = briefFromWork({ sources: oneJob, businessType: 'Plumber', publishedThisMonth: 0 })
    if (dentist.ok) expect(dentist.requiresReview).toBe(true)
    if (plumber.ok) expect(plumber.requiresReview).toBe(false)
  })
})

describe('publishing an article', () => {
  const body = Array(200).fill('word').join(' ')

  it('never publishes without a person approving', () => {
    // Same discipline as sequences: nothing reaches the public until somebody
    // turns it on.
    expect(canPublishDraft({ body, requiresReview: false, approvedByUser: false }).ok).toBe(false)
  })

  it('refuses something too short to be worth publishing', () => {
    expect(canPublishDraft({ body: 'Too short.', requiresReview: false, approvedByUser: true }).ok).toBe(false)
  })

  it('refuses regulated advice with no named reviewer', () => {
    expect(canPublishDraft({ body, requiresReview: true, approvedByUser: true }).ok).toBe(false)
    expect(canPublishDraft({
      body, requiresReview: true, approvedByUser: true,
      reviewedByName: 'Dr Priya Raman', dateReviewed: new Date(),
    }).ok).toBe(true)
  })

  it('refuses a reviewer name with no date, and a date with no name', () => {
    // Half a claim is still a claim about who checked it.
    expect(canPublishDraft({ body, requiresReview: true, approvedByUser: true, reviewedByName: 'Someone' }).ok).toBe(false)
    expect(canPublishDraft({ body, requiresReview: true, approvedByUser: true, dateReviewed: new Date() }).ok).toBe(false)
  })
})

describe('Search Console', () => {
  it('refuses loudly when unconfigured, rather than returning nothing', async () => {
    // An empty array would render as "no search traffic", the operator would
    // conclude their site has no visibility, and nobody would discover the
    // integration was never switched on.
    const provider = new UnconfiguredSearchConsoleProvider()
    expect(provider.isConfigured()).toBe(false)
    expect(() => provider.authorizationUrl()).toThrow(/not configured/i)
    await expect(provider.listSites()).rejects.toThrow()
  })

  it('asks for offline access, or the connection dies within the hour', () => {
    const provider = new GoogleSearchConsoleProvider('client-id', 'client-secret')
    const url = provider.authorizationUrl({ organizationId: 'org', redirectUri: 'https://example.com/return', state: 'org.nonce' })
    expect(url).toContain('access_type=offline')
    // Without prompt=consent a re-authorisation returns no refresh token at all.
    expect(url).toContain('prompt=consent')
  })

  it('asks only for read access', () => {
    const provider = new GoogleSearchConsoleProvider('client-id', 'client-secret')
    const url = provider.authorizationUrl({ organizationId: 'org', redirectUri: 'https://example.com/return', state: 'org.nonce' })
    expect(url).toContain('webmasters.readonly')
    expect(url).not.toMatch(/webmasters(?!\.readonly)/)
  })

  it('returns the unconfigured provider when no client is set', () => {
    const previous = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET }
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    try {
      expect(searchConsoleProvider().isConfigured()).toBe(false)
    } finally {
      if (previous.id) process.env.GOOGLE_OAUTH_CLIENT_ID = previous.id
      if (previous.secret) process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret
    }
  })
})

describe('the website plugin holds no customer data', () => {
  const publicSite = fs.readFileSync(path.join(__dirname, '../src/routes/publicSite.ts'), 'utf8')

  it('never reads contacts, messages, deals or bookings', () => {
    // The whole security posture: if the customer's WordPress is compromised,
    // nothing about THEIR customers leaks, because none of it is reachable.
    for (const model of ['Contact.find', 'Message.find', 'Deal.find', 'Appointment.find', 'Contact.findOne']) {
      expect(publicSite, `publicSite reaches ${model}`).not.toContain(model)
    }
  })

  it('stores the token hashed, never in the clear', () => {
    expect(publicSite).toContain('siteTokenHash')
    expect(publicSite).toMatch(/createHash\('sha256'\)/)
  })

  it('gives the same answer for a wrong code and an expired one', () => {
    // Distinguishing them tells an attacker which codes exist.
    const matches = publicSite.match(/pairing code is not valid/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('accepts no identity on the public event endpoint', () => {
    // A public endpoint that accepted a contact identity would be a way to
    // write into somebody's CRM from outside.
    expect(publicSite).toContain('contactId: null')
  })
})
