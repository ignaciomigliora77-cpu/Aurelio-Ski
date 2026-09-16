import { icon } from './icons.js'

export const money = (n) =>
  '$\u00A0' + Math.round(n).toLocaleString('es-AR')

export const titleCase = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const fmtDate = (t) =>
  new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(t)

export const fmtTime = (t) =>
  new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(t)

export const fmtDateTime = (t) => `${fmtDate(t)} · ${fmtTime(t)}`

export const haptic = (pattern = 12) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* noop */
  }
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))

export const shuffle = (arr) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/* ---------- Toasts ---------- */

const frame = () => document.querySelector('#app') || document.body

let toastsRoot = null

export function toast(message, type = 'info') {
  if (!toastsRoot || !toastsRoot.isConnected) {
    toastsRoot = document.createElement('div')
    toastsRoot.className = 'toasts'
    frame().appendChild(toastsRoot)
  }
  const el = document.createElement('div')
  el.className = `toast toast--${type}`
  const msg = document.createElement('span')
  msg.textContent = message
  el.appendChild(msg)
  toastsRoot.appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s ease, transform 0.3s ease'
    el.style.opacity = '0'
    el.style.transform = 'translateY(-8px)'
    setTimeout(() => el.remove(), 320)
  }, 2400)
}

function toastIcon(name, color, message) {
  if (!toastsRoot || !toastsRoot.isConnected) {
    toastsRoot = document.createElement('div')
    toastsRoot.className = 'toasts'
    frame().appendChild(toastsRoot)
  }
  const el = document.createElement('div')
  el.className = 'toast toast--success'
  const badge = document.createElement('span')
  badge.style.cssText = `color:var(--${color});display:inline-flex;align-items:center`
  badge.innerHTML = icon(name, 16, 2.4)
  const msg = document.createElement('span')
  msg.textContent = message
  el.appendChild(badge)
  el.appendChild(msg)
  toastsRoot.appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s ease, transform 0.3s ease'
    el.style.opacity = '0'
    el.style.transform = 'translateY(-8px)'
    setTimeout(() => el.remove(), 320)
  }, 2400)
}

export const ok = (msg) => {
  haptic([18])
  toastIcon('check', 'green', msg)
}

export const err = (msg) => {
  haptic([40, 60, 40])
  toastIcon('xmark', 'red', msg)
}

/* ---------- Sheet (bottom) ---------- */

export function openSheet({ title, body, footer, onClose }) {
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const sheet = document.createElement('div')
  sheet.className = 'sheet'

  const close = () => {
    overlay.remove()
    sheet.remove()
    onClose?.()
  }
  overlay.addEventListener('click', close)

  sheet.innerHTML = `
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h3>${esc(title)}</h3>
      <button class="icon-btn" data-close aria-label="Cerrar">${icon('xmark', 16, 2)}</button>
    </div>
    <div class="sheet-body">${body || ''}</div>
    ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}
  `

  sheet.querySelector('[data-close]').addEventListener('click', close)

  const onEscape = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onEscape, { once: true })

  const host = frame()
  host.appendChild(overlay)
  host.appendChild(sheet)
  return { close, root: sheet, overlay }
}

/* ---------- Empty state ---------- */

export const emptyState = (icName, title, sub) => `
  <div class="empty">
    ${icon(icName, 46, 1.4)}
    <h4>${esc(title)}</h4>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
  </div>
`