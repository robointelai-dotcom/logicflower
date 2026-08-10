import { describe, expect, it } from 'vitest'
import { buildBusinessGraph, BUSINESS_TYPES, isKnownBusinessType } from '../src/services/content/entityGraph'
import { clusterQuestions, MIN_ASKS_TO_SURFACE } from '../src/services/visibility/questions'
import { ATTRIBUTION_WINDOW_DAYS, SOURCE_LABELS } from '../src/services/visibility/attribution'

const BASE = {
  tradingName: 'Ridgeway Plumbing',
  businessType: 'Plumber',
  url: 'https://example.com',
  city: 'Chennai',
  addressLine1: '4 Mount Road',
}

describe('business entity graph', () => {
  it('emits the specific subtype, not a generic one', () => {
    // A dentist emitting bare LocalBusiness loses the properties that make a
    // dentist findable, and nothing infers them from the trading name.
    const graph: any = buildBusinessGraph({ ...BASE, businessType: 'Dentist' })
    expect(graph['@graph'][0]['@type']).toBe('Dentist')
  })

  it('falls back to LocalBusiness only for an unknown type', () => {
    const graph: any = buildBusinessGraph({ ...BASE, businessType: 'NotARealType' })
    expect(graph['@graph'][0]['@type']).toBe('LocalBusiness')
    expect(isKnownBusinessType('NotARealType')).toBe(false)
    expect(isKnownBusinessType('Plumber')).toBe(true)
  })

  it('offers a readable label for every type an operator can pick', () => {
    for (const entry of BUSINESS_TYPES) {
      expect(entry.label.length).toBeGreaterThan(2)
      expect(entry.group.length).toBeGreaterThan(2)
    }
  })

  it('never emits a credential nobody entered', () => {
    // A fabricated professional registration is a false statement about a
    // regulated trade, not an optimisation.
    const bare: any = buildBusinessGraph(BASE)
    expect(bare['@graph'][0].hasCredential).toBeUndefined()

    const named: any = buildBusinessGraph({
      ...BASE,
      credentials: [{ name: 'Gas Safe registered', identifier: '123456' }],
    })
    expect(named['@graph'][0].hasCredential[0].name).toBe('Gas Safe registered')
  })

  it('drops a credential row with no name rather than inventing one', () => {
    const graph: any = buildBusinessGraph({
      ...BASE,
      credentials: [{ name: '', issuedBy: 'Somebody' }, { name: 'Real one' }],
    })
    expect(graph['@graph'][0].hasCredential).toHaveLength(1)
  })

  it('emits holiday closures, not just the weekly pattern', () => {
    // A business showing "open" on a bank holiday produces a wasted journey and
    // a one-star review — the opposite of what this module is for.
    const graph: any = buildBusinessGraph({
      ...BASE,
      openingHours: [{ day: 'mon', opens: '09:00', closes: '17:00' }],
      hoursExceptions: [{ date: '2026-12-25', closed: true }],
    })
    const spec = graph['@graph'][0].openingHoursSpecification
    expect(spec).toHaveLength(2)
    const christmas = spec.find((entry: any) => entry.validFrom === '2026-12-25')
    expect(christmas.opens).toBe('00:00')
    expect(christmas.closes).toBe('00:00')
  })

  it('treats a closed day as closed even when times are left behind', () => {
    const graph: any = buildBusinessGraph({
      ...BASE,
      openingHours: [{ day: 'sun', opens: '09:00', closes: '17:00', closed: true }],
    })
    expect(graph['@graph'][0].openingHoursSpecification ?? []).toHaveLength(0)
  })

  it('describes a service area, because where they work is not where they are', () => {
    const named: any = buildBusinessGraph({
      ...BASE, serviceAreaKind: 'named', serviceAreaPlaces: ['Adyar', 'Velachery'],
    })
    expect(named['@graph'][0].areaServed).toHaveLength(2)

    const radius: any = buildBusinessGraph({
      ...BASE, serviceAreaKind: 'radius', serviceAreaRadiusKm: 30, latitude: 13.08, longitude: 80.27,
    })
    expect(radius['@graph'][0].areaServed['@type']).toBe('GeoCircle')
    expect(radius['@graph'][0].areaServed.geoRadius).toBe(30_000)
  })

  it('emits no rating when there are no published reviews', () => {
    // Including hidden or unmoderated reviews in the average would be a false
    // claim in structured data.
    const none: any = buildBusinessGraph({ ...BASE, aggregateRating: { ratingValue: 0, reviewCount: 0 } })
    expect(none['@graph'][0].aggregateRating).toBeUndefined()

    const some: any = buildBusinessGraph({ ...BASE, aggregateRating: { ratingValue: 4.66, reviewCount: 12 } })
    expect(some['@graph'][0].aggregateRating.ratingValue).toBe(4.7)
  })

  it('binds the FAQ to the business rather than floating it', () => {
    const graph: any = buildBusinessGraph({
      ...BASE,
      capsules: [{ question: 'Do you do Sunday callouts?', answer: 'Yes, at a higher rate.' }],
    })
    const faq = graph['@graph'].find((node: any) => node['@type'] === 'FAQPage')
    expect(faq.about['@id']).toBe(graph['@graph'][0]['@id'])
  })

  it('contains no null or empty properties', () => {
    const graph = buildBusinessGraph({ tradingName: 'X', url: 'https://example.com' })
    expect(JSON.stringify(graph)).not.toContain('null')
    expect(JSON.stringify(graph)).not.toContain('""')
  })
})

describe('finding the questions customers actually ask', () => {
  const asked = (text: string, days = 1) => ({ text, at: new Date(Date.now() - days * 86_400_000) })

  it('groups the same question asked in different words', () => {
    const clusters = clusterQuestions([
      asked('Do you do emergency callouts on Sunday?'),
      asked('Are emergency callouts available Sunday?'),
      asked('do you offer emergency callout sunday'),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.count).toBe(3)
  })

  it('ignores a question only one person asked', () => {
    // One person asking is a conversation, not a pattern. Surfacing it buries
    // the questions that matter.
    expect(clusterQuestions([asked('Do you service boilers in Adyar?')])).toHaveLength(0)
    expect(MIN_ASKS_TO_SURFACE).toBe(2)
  })

  it('catches a question with no question mark', () => {
    const clusters = clusterQuestions([
      asked('do you cover velachery area'),
      asked('Do you cover the Velachery area'),
    ])
    expect(clusters).toHaveLength(1)
  })

  it('ignores statements', () => {
    expect(clusterQuestions([
      asked('My boiler is leaking badly.'),
      asked('The boiler leaks badly now.'),
    ])).toHaveLength(0)
  })

  it('keeps verbatim examples, so the operator sees the real wording', () => {
    const clusters = clusterQuestions([
      asked('How much for a boiler service?'),
      asked('how much does boiler servicing cost'),
    ])
    expect(clusters[0]!.examples.length).toBeGreaterThan(0)
    expect(clusters[0]!.examples[0]).toMatch(/boiler/i)
  })

  it('tidies the question it presents without inventing content', () => {
    const clusters = clusterQuestions([
      asked('how much for a boiler service'),
      asked('How much for boiler service???'),
    ])
    expect(clusters[0]!.question).toMatch(/^How much/)
    expect(clusters[0]!.question.endsWith('?')).toBe(true)
    expect(clusters[0]!.question).not.toContain('??')
  })

  it('survives empty and malformed input', () => {
    for (const input of [[], [{ text: '' }], [{ text: '???' }], [{ text: 'a' }]]) {
      expect(() => clusterQuestions(input as any)).not.toThrow()
    }
  })
})

describe('attribution rules', () => {
  it('uses a window long enough for a quote-to-job cycle', () => {
    expect(ATTRIBUTION_WINDOW_DAYS).toBe(90)
  })

  it('has a plain-English label for every source, including not knowing', () => {
    expect(SOURCE_LABELS.unknown).toMatch(/know/i)
    for (const label of Object.values(SOURCE_LABELS)) {
      expect(label.length).toBeGreaterThan(3)
      // These appear on a screen a plumber reads between jobs.
      expect(label).not.toMatch(/_|[A-Z]{3,}/)
    }
  })
})
