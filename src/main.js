import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { initData } from './db/index.js'
import { seed } from './db/seed.js'
import { restoreSession, getSession, logout, touch, isSessionExpired, isIdleExpired } from './auth/index.js'
import { ensureDefaultPromoter, startPromotersSync } from './promoters/firebase-promoters.js'
import { startRouter, navigate } from './router.js'
import { toast } from './ui/components.js'

registerSW({ immediate: true })

async function boot() {
  try {
    await initData()
    await seed()
    await ensureDefaultPromoter()
    await startPromotersSync()
    await restoreSession()
  } catch (e) {
    console.error('boot', e)
    toast('Problema de conexión con la base de datos · reintentando')
  }
  startRouter()
  setupIdleGuard()
}

function setupIdleGuard() {
  const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'scroll']
  for (const ev of ACTIVITY) window.addEventListener(ev, touch, { passive: true })
  setInterval(async () => {
    if (!getSession()) return
    if (isSessionExpired() || isIdleExpired()) {
      await logout()
      navigate('login', true)
    }
  }, 30000)
}

boot()