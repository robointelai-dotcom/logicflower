/**
 * Finding the questions customers actually ask.
 *
 * WHY THIS BEATS A KEYWORD TOOL
 *
 * A keyword tool tells you that 480 people a month search "emergency plumber".
 * This tells you that twelve people asked THIS business whether it does Sunday
 * callouts, in their own words. The second is more specific, more current, and
 * available to nobody else — it is in the inbox this product already owns.
 *
 * The clustering is deliberately simple. A language model would group better,
 * but this runs over every inbound message in a workspace and the operator
 * approves every result anyway. A cheap, explainable pass that an operator
 * corrects beats an expensive one they cannot audit.
 */

export interface InboundText {
  text: string
  at?: Date | null
}

export interface QuestionCluster {
  question: string
  count: number
  lastAskedAt: Date | null
  /** Verbatim, so the operator sees what people actually wrote. */
  examples: string[]
}

/** Words that carry no topic. Removed before comparing two questions. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'do', 'does', 'did', 'can', 'could',
  'would', 'will', 'shall', 'should', 'have', 'has', 'had', 'i', 'you', 'we',
  'they', 'it', 'my', 'your', 'our', 'to', 'of', 'in', 'on', 'at', 'for',
  'and', 'or', 'but', 'if', 'be', 'been', 'am', 'me', 'us', 'them', 'this',
  'that', 'these', 'those', 'there', 'here', 'please', 'thanks', 'thank',
  'hi', 'hello', 'hey', 'just', 'want', 'need', 'know', 'get', 'any', 'some',
])

/**
 * Is this sentence a question?
 *
 * A question mark is the strong signal. Failing that, an opening interrogative
 * — "do you", "how much", "can you" — catches the many people who never type
 * one.
 */
function looksLikeQuestion(sentence: string): boolean {
  const text = sentence.trim()
  if (!text) return false
  if (text.endsWith('?')) return true
  return /^(do|does|can|could|would|will|is|are|have|has|what|when|where|why|how|which|who)\b/i.test(text)
}

function topicWords(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
}

/** Overlap between two sets of topic words, 0 to 1. */
function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const setA = new Set(a)
  const shared = b.filter((word) => setA.has(word)).length
  return shared / Math.max(a.length, b.length)
}

/** Sentence case, one question mark, bounded length. */
function tidy(sentence: string): string {
  const text = sentence.trim().replace(/\s+/g, ' ').replace(/\?+$/, '')
  const cased = text.charAt(0).toUpperCase() + text.slice(1)
  return `${cased.slice(0, 200)}?`
}

export const MIN_ASKS_TO_SURFACE = 2

/**
 * Group similar questions.
 *
 * Only clusters asked more than once are returned. A question asked by one
 * person is a conversation, not a pattern — surfacing it would bury the ones
 * that matter under noise.
 */
export function clusterQuestions(messages: InboundText[], options: { minAsks?: number } = {}): QuestionCluster[] {
  const minAsks = options.minAsks ?? MIN_ASKS_TO_SURFACE

  const questions: Array<{ text: string; words: string[]; at: Date | null }> = []
  for (const message of messages) {
    for (const sentence of String(message.text ?? '').split(/(?<=[.?!])\s+|\n+/)) {
      if (!looksLikeQuestion(sentence)) continue
      const words = topicWords(sentence)
      // Under two topic words there is nothing to match on: "can you?" tells
      // us nothing about what was asked.
      if (words.length < 2) continue
      questions.push({ text: sentence.trim(), words, at: message.at ?? null })
    }
  }

  const clusters: Array<{ words: string[]; members: typeof questions }> = []
  for (const question of questions) {
    const match = clusters.find((cluster) => similarity(cluster.words, question.words) >= 0.5)
    if (match) {
      match.members.push(question)
      continue
    }
    clusters.push({ words: question.words, members: [question] })
  }

  return clusters
    .filter((cluster) => cluster.members.length >= minAsks)
    .map((cluster) => {
      // The shortest phrasing is usually the clearest, and it is what the
      // operator will want to publish.
      const shortest = [...cluster.members].sort((a, b) => a.text.length - b.text.length)[0]!
      const dates = cluster.members.map((member) => member.at).filter(Boolean) as Date[]
      return {
        question: tidy(shortest.text),
        count: cluster.members.length,
        lastAskedAt: dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : null,
        examples: [...new Set(cluster.members.map((member) => member.text))].slice(0, 3),
      }
    })
    .sort((a, b) => b.count - a.count)
}
