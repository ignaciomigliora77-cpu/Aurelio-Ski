import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { seed } from './db/seed.js'
import { restoreSession, getSession, logout, touch, isSessionExpired, isIdleExpired } from './auth/index.js'
import { startRouter, navigate } from './router.js'
import { icon } from './ui/icons.js'
import { toast } from './ui/components.js'

registerSW({ immediate: true })

function setupNetStatus() {
  const pill = document.createElement('div')
  pill.id = 'netpill'
  pill.className = 'netpill'
  pill.innerHTML = `${icon('wifi-off', 14, 2)} <span>Modo autónomo · sin conexión</span>`
  document.body.appendChild(pill)

  const update = () => {
    pill.classList.toggle('offline', !navigator.onLine)
  }
  window.addEventListener('online', update)
  window.addEventListener('offline', update)
  update()
}

function setupIdleGuard() {
  const events = ['pointerdown', 'keydown', 'touchstart', 'wheel']
  const onActivity = () => touch()
  events.forEach((t) => window.addEventListener(t, onActivity, { passive: true }))
  setInterval(async () => {
    if (!getSession()) return
    if (isSessionExpired()) {
      await logout()
      toast('Sesión vencida · iniciá sesión de nuevo')
      navigate('login', true)
      return
    }
    if (isIdleExpired()) {
      await logout()
      toast('Sesión cerrada por inactividad')
      navigate('login', true)
    }
  }, 15000)
}

async function boot() {
  await seed()
  await restoreSession()
  setupNetStatus()
  startRouter()
  setupIdleGuard()
}

boot()