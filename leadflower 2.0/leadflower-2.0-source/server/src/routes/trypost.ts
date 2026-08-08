import { Router } from 'express'
import axios from 'axios'
import pino from '../logger'
import User from '../models/User'

import { authenticate } from '../middleware/authenticate'

const router = Router()

router.get('/sso', authenticate, async (req, res, next) => {
  try {
    const auth = (req as any).auth
    if (!auth || !auth.userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const user = await User.findById(auth.userId).lean()
    if (!user) {
      return res.status(401).json({ error: 'User not found' })
    }

    const baseUrl = process.env.TRYPOST_BASE_URL || 'http://139.99.134.4:8001'
    const secret = process.env.TRYPOST_ADMIN_API_KEY || 'leadflower-secret-123'
    
    // Ping the Trypost server to provision the user and get a magic login link
    const response = await axios.post(`${baseUrl}/sso/provision`, {
      secret: secret,
      email: user.email,
      name: user.displayName || 'User',
      organizationId: auth.organizationId
    })

    res.json({ url: response.data.url })
  } catch (error) {
    pino.error({ error }, 'Failed to provision Trypost user')
    next(error)
  }
})

router.post('/verify', async (req, res, next) => {
  try {
    const { email, password, secret } = req.body
    const expectedSecret = process.env.TRYPOST_ADMIN_API_KEY || 'leadflower-secret-123'
    if (secret !== expectedSecret) {
      return res.status(401).json({ success: false })
    }

    const user: any = await User.findOne({ email }).select('+passwordHash')
    if (!user || user.status !== 'active') {
      return res.json({ success: false })
    }

    const bcrypt = require('bcryptjs')
    const valid = await bcrypt.compare(password, user.passwordHash)
    
    if (valid) {
      return res.json({ success: true, user: { email: user.email, name: user.displayName || 'User' } })
    }
    return res.json({ success: false })
  } catch (error) {
    pino.error({ error }, 'Failed to verify Trypost credentials')
    next(error)
  }
})

export default router
