import React, { useEffect } from 'react'
import { PageHeader } from '../components/ui'

export default function TrypostPage() {
  useEffect(() => {
    // Directly redirect to the Trypost application login page as requested
    window.location.href = 'http://139.99.134.4:8001/login'
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100vh - 64px)' }}>
      <PageHeader
        eyebrow="Social Media Auto Post"
        title="Opening Social Dashboard..."
        description="Redirecting you to the Trypost login page..."
      />
      
      <div style={{ marginTop: '40px', display: 'flex', justifyContent: 'center' }}>
        <div className="spinner" style={{ border: '4px solid rgba(0,0,0,0.1)', width: '36px', height: '36px', borderRadius: '50%', borderLeftColor: 'var(--primary)' }}></div>
      </div>
    </div>
  )
}
