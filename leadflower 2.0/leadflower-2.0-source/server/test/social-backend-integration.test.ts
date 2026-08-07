import { describe, expect, it } from 'vitest'
import { mapPlatformStatus, trypostConfigured } from '../src/services/social/trypostClient'
import { workspaceKeyAad } from '../src/services/social/trypostPublisher'

describe('social publishing backend integration', () => {
  it('is disabled when no backend is configured', () => {
    // Absent configuration means posts compose and schedule but never publish,
    // which is the Phase 4 behaviour. It must not silently half-enable.
    expect(trypostConfigured()).toBe(false)
  })

  it('binds a workspace credential to its own organisation', () => {
    // The backend scopes API keys to a workspace, so using another
    // organisation's key is a cross-tenant write. The AAD makes a ciphertext
    // unusable outside the record it belongs to.
    expect(workspaceKeyAad('org-1')).not.toBe(workspaceKeyAad('org-2'))
    expect(workspaceKeyAad('org-1')).toContain('org-1')
  })

  it('never maps an unrecognised platform status to published', () => {
    // Treating an unknown state as success is how a failed post gets reported
    // as live to a customer.
    expect(mapPlatformStatus('published')).toBe('published')
    expect(mapPlatformStatus('posted')).toBe('published')
    expect(mapPlatformStatus('failed')).toBe('failed')
    expect(mapPlatformStatus('error')).toBe('failed')
    expect(mapPlatformStatus('scheduled')).toBe('pending')
    expect(mapPlatformStatus('queued')).toBe('pending')

    for (const unknown of ['', 'weird_new_state', 'partially_done', 'reviewing']) {
      expect(mapPlatformStatus(unknown)).toBe('publishing')
      expect(mapPlatformStatus(unknown)).not.toBe('published')
    }
  })

  it('treats status mapping as case-insensitive', () => {
    expect(mapPlatformStatus('PUBLISHED')).toBe('published')
    expect(mapPlatformStatus('Failed')).toBe('failed')
  })
})
