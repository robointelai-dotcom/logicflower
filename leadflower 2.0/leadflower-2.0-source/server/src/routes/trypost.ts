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

    // Ping the Trypost server to provision the user and get a magic login link
    const response = await axios.post('http://139.99.134.4:8001/sso/provision', {
      secret: 'leadflower-secret-123',
      email: user.email,
      name: user.displayName || 'User'
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
    if (secret !== 'leadflower-secret-123') {
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
