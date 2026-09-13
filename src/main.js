import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { ensureAuth } from './firebase.js'
import { initData, checkConnection } from './db/index.js'
import { seed } from './db/seed.js'
import { restoreSession, getSession, logout, touch, isSessionExpired, isIdleExpired } from './auth/index.js'
import { ensureDefaultPromoter, startPromotersSync } from './promoters/firebase-promoters.js'
import { startRouter, navigate } from './router.js'
import { icon } from './ui/icons.js'
import { toast } from './ui/components.js'

registerSW({ immediate: true })

let blocked = false

function blocker() {
  let el = document.getElementById('netblock')
  if (!el) {
    el = document.createElement('div')
    el.id = 'netblock'
    el.className = 'netblock'
    el.innerHTML = `
      <div class="netblock-card">
        <div class="netblock-icon">${icon('wifi-off', 30, 2)}</div>
        <h2>Se requiere internet para operar</h2>
        <p>La aplicación sincroniza sus datos en la nube en tiempo real. Reconectate para continuar.</p>
      </div>`
    document.body.appendChild(el)
  }
  el.classList.add('show')
}

function unblock() {
  const el = document.getElementById('netblock')
  if (el) el.classList.remove('show')
}

function setupNetStatus() {
  window.addEventListener('offline', () => {
    blocked = true
    blocker()
  })
  window.addEventListener('online', () => {
    if (!blocked) return
    blocked = false
    setTimeout(() => window.location.reload(), 800)
  })
}

async function boot() {
  try {
    await ensureAuth()
    await checkConnection()
  } catch {
    blocked = true
    blocker()
    return
  }

  await initData()
  await seed()
  await ensureDefaultPromoter()
  await startPromotersSync()
  await restoreSession()

  setupNetStatus()
  startRouter()
  setupIdleGuard()
  if (blocked) unblock()
}

boot()