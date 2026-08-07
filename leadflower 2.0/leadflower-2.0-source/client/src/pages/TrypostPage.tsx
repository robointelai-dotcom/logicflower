import React, { useEffect, useState } from 'react'
import { PageHeader } from '../components/ui'
import { api } from '../api/client'

export default function TrypostPage() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadTrypost() {
      try {
        const response = await api.get('/trypost/sso')
        window.location.href = response.data.url
      } catch (err) {
        console.error(err)
        setError('Failed to securely connect to the Social Dashboard. Please try again.')
        setLoading(false)
      }
    }
    loadTrypost()
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100vh - 64px)' }}>
      <PageHeader
        eyebrow="Social Media Auto Post"
        title="Opening Social Dashboard..."
        description="Please wait a moment while we securely log you in."
      />
      
      {error ? (
        <div style={{ marginTop: '20px', padding: '16px', background: '#fee2e2', color: '#b91c1c', borderRadius: '8px' }}>
          {error}
        </div>
      ) : loading ? (
        <div style={{ marginTop: '40px', display: 'flex', justifyContent: 'center' }}>
          <div className="spinner" style={{ border: '4px solid rgba(0,0,0,0.1)', width: '36px', height: '36px', borderRadius: '50%', borderLeftColor: 'var(--primary)' }}></div>
        </div>
      ) : null}
    </div>
  )
}
