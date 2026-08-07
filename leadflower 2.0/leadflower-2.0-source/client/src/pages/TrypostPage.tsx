import React from 'react'
import { PageHeader } from '../components/ui'

export default function TrypostPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100vh - 64px)' }}>
      <PageHeader
        eyebrow="Social Media Auto Post"
        title="Social Dashboard"
        description="Manage your automated social media posting campaigns."
      />
      <div style={{ flex: 1, position: 'relative', marginTop: '16px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
        <iframe
          src="http://139.99.134.4:8001"
          style={{ width: '100%', height: '100%', minHeight: '800px', border: 'none' }}
          title="Trypost Dashboard"
        />
      </div>
    </div>
  )
}
