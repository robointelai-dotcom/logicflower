import { Router } from 'express'
import axios from 'axios'
import pino from '../logger'
import User from '../models/User'

const router = Router()

router.get('/sso', async (req, res, next) => {
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

export default router
