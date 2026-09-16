import './styles/theme.css'
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
  setupZoomLock()
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

/* iOS ignora `user-scalable=no` por accesibilidad: reforzamos el bloqueo de
   zoom con gestos nativos + supresión de doble-tap (pinch y zoom del doble
   tap quedan inertes, pero los botones/scroll siguen funcionando). */
function setupZoomLock() {
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault())
  }
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault()
    },
    { passive: false }
  )
  let lastTap = 0
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now()
      if (e.changedTouches?.length === 1 && now - lastTap < 350) e.preventDefault()
      lastTap = now
    },
    { passive: false }
  )
}

boot()