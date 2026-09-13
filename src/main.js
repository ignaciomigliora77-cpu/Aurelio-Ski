import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { seed } from './db/seed.js'
import { restoreSession, getSession, logout, touch, isSessionExpired, isIdleExpired } from './auth/index.js'
import { startRouter, navigate } from './router.js'
import { icon } from './ui/icons.js'
import { toast } from './ui/components.js'

registerSW({ immediate: true })

/*
 * ============================================================================
 * SIMULADOR DE DISPOSITIVOS — ESTRICTAMENTE TEMPORAL
 * ----------------------------------------------------------------------------
 * La barra superior (#simibar) y el marco #device existen para previsualizar
 * los factores de forma (MacBook / iPad / iPhone) durante las fases de prueba
 * y validación. Se eliminan POR COMPLETO en el despliegue final a producción,
 * cuando la aplicación corra de forma nativa en cada hardware.
 *
 * Para retirarlo: poné DEVICE_SIM = false y borrá <div id="simibar"> de
 * index.html junto con el comentario correspondiente.
 * ============================================================================
 */
const DEVICE_SIM = true

const DV_KEY = 'aurelio.device'

const DV_SIZE = {
  phone: { w: 390, h: 844 },
  tablet: { w: 834, h: 1112 },
  notebook: { w: 1440, h: 900 },
}

function setupDeviceFrame() {
  const bar = document.querySelector('#simibar')
  if (!bar) return
  const sizeLabel = bar.querySelector('#simi-size')

  const apply = (name) => {
    document.body.classList.remove('dv-phone', 'dv-tablet', 'dv-notebook')
    document.body.classList.add(`dv-${name}`)
    localStorage.setItem(DV_KEY, name)
    bar.querySelectorAll('[data-dv]').forEach((b) => {
      b.classList.toggle('on', b.dataset.dv === name)
    })
    window.requestAnimationFrame(() => {
      setTimeout(() => updateSize(), 380)
    })
  }

  const updateSize = () => {
    const app = document.querySelector('#app')
    if (!app) return
    const w = app.clientWidth || DV_SIZE[document.body.classList.contains('dv-phone') ? 'phone' : 'notebook'].w
    const h = app.clientHeight || DV_SIZE.notebook.h
    sizeLabel.textContent = `${w} × ${h}`
  }

  bar.querySelectorAll('[data-dv]').forEach((b) => {
    b.addEventListener('click', () => apply(b.dataset.dv))
  })

  window.addEventListener('resize', () => {
    const active = [...bar.querySelectorAll('[data-dv]')].find((b) => b.classList.contains('on'))
    if (active?.dataset.dv === 'notebook') updateSize()
  })

  const saved = localStorage.getItem(DV_KEY)
  apply(saved === 'phone' || saved === 'tablet' || saved === 'notebook' ? saved : 'notebook')
}

function setupNetStatus() {
  const pill = document.createElement('div')
  pill.id = 'netpill'
  pill.className = 'netpill'
  pill.innerHTML = `${icon('wifi-off', 14, 2)} <span>Modo autónomo · sin conexión</span>`
  ;(document.querySelector('#device') || document.body).appendChild(pill)

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
  if (DEVICE_SIM) setupDeviceFrame()
  setupNetStatus()
  startRouter()
  setupIdleGuard()
}

boot()