import { BOXES, ORDERS, resetFirebase } from '../db/index.js'
import { uid } from '../ui/components.js'
import { hashPassword, verifyPassword, verifySessionCred as verifyCred } from './crypto.js'
import { logAudit } from '../db/audit.js'
import { listPromoters as firebaseListPromoters, findByUsername, updatePromoter } from '../promoters/firebase-promoters.js'

const KEY = 'aurelio.session'

export const SESSION_TTL_MS = 8 * 3600e3

const isTouchDevice = () => {
  try {
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
  } catch {
    return false
  }
}

export const IDLE_MS = {
  promotor: (isTouchDevice() ? 30 : 5) * 60e3,
  default: (isTouchDevice() ? 45 : 15) * 60e3,
}

export const ROLES = {
  PROMOTOR: { id: 'promotor', label: 'Promotor de Pista', short: 'Promotor', tab: 'promotor' },
  VENTAS: { id: 'ventas', label: 'Ventas / Tablet', short: 'Ventas', tab: 'ventas' },
  BOTAS: { id: 'botas', label: 'Botas de Esquí y Snow', short: 'Botas', tab: 'botas' },
  EQUIPO: { id: 'equipo', label: 'Equipo SKI', short: 'Equipo SKI', tab: 'equipo' },
  ROPA: { id: 'ropa', label: 'Ropa / Indumentaria', short: 'Ropa', tab: 'ropa' },
  RECEPCION: { id: 'recepcion', label: 'Recepción', short: 'Recepción', tab: 'recepcion' },
}

/*
 * Roles fijos PROTEGIDOS del sistema. Los promotores de pista se administran
 * en el panel de Economía (Recepción) y viven en la tabla `promoters`.
 * Clave PROVISIONAL de prueba: Na212121. En producción se reemplaza por la
 * clave personal real de cada operador (se configura aquí / panel admin).
 */
export const USERS = [
  { username: 'ventas', password: 'Na212121', roleId: 'VENTAS' },
  { username: 'botas', password: 'Na212121', roleId: 'BOTAS' },
  { username: 'equipo', password: 'Na212121', roleId: 'EQUIPO' },
  { username: 'ropa', password: 'Na212121', roleId: 'ROPA' },
  { username: 'recepcion', password: 'Na212121', roleId: 'RECEPCION' },
]

export const listPromoters = () => firebaseListPromoters()

let session = null

let lastActivity = Date.now()

export const getSession = () => session

export const touch = () => {
  lastActivity = Date.now()
}

export const idleMs = () => IDLE_MS[session?.role?.id] ?? IDLE_MS.default

export const isIdleExpired = () => Date.now() - lastActivity > idleMs()

export const isSessionExpired = () => {
  if (!session) return false
  return Date.now() - session.loginAt > SESSION_TTL_MS
}

export const verifySessionCred = (password) => verifyCred(session, password)

export async function ensureSessionActive() {
  if (!session) {
    await logout()
    return false
  }
  if (isSessionExpired()) {
    await logout()
    return false
  }
  return true
}

export async function restoreSession() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    const staticOk = USERS.some((u) => u.username === data?.username)
    const promoterOk = staticOk ? false : findByUsername(data?.username || '')
    if ((!staticOk && !promoterOk) || !data?.role?.id || !data?.sessionId) {
      session = null
      localStorage.removeItem(KEY)
      return null
    }
    if (Date.now() - (data.loginAt || 0) > SESSION_TTL_MS) {
      session = null
      localStorage.removeItem(KEY)
      return null
    }
    session = data
    lastActivity = Date.now()
    return session
  } catch {
    session = null
    return null
  }
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export async function validateCredentials(usernameRaw, passwordRaw) {
  const username = String(usernameRaw || '').trim().toLowerCase()
  const password = String(passwordRaw || '')
  const fixed = USERS.find((u) => u.username === username && u.password === password)
  if (fixed) return { username: fixed.username, role: ROLES[fixed.roleId], legacy: false }
  const promo = findByUsername(username)
  if (!promo) return null
  const check = await verifyPassword(password, promo.password)
  if (!check.match) return null
  return {
    username: promo.username,
    role: ROLES.PROMOTOR,
    legacy: check.legacy,
    stored: check.legacy ? null : check.stored,
    promoterId: promo.id,
  }
}

export async function openBoxFor(session) {
  const existing = await BOXES().where('sessionId').equals(session.sessionId).first()
  if (existing) return existing
  const box = {
    id: uid(),
    sessionId: session.sessionId,
    openedBy: session.username,
    openedAt: Date.now(),
    closedAt: null,
    closingTotal: null,
  }
  await BOXES().add(box)
  return box
}

export async function closeBoxFor(session) {
  const box = await BOXES().where('sessionId').equals(session.sessionId).first()
  if (!box || box.closedAt) return
  const orders = await ORDERS().where('sessionId').equals(session.sessionId).toArray()
  const closingTotal = orders.filter((o) => o.state === 'aprobada').reduce((acc, o) => acc + (o.total || 0), 0)
  await BOXES().update(box.id, { closedAt: Date.now(), closingTotal })
}

export async function login(usernameRaw, passwordRaw) {
  const creds = await validateCredentials(usernameRaw, passwordRaw)
  if (!creds) {
    const error = new Error('Credenciales incorrectas')
    error.code = 'INVALID_CREDENTIALS'
    throw error
  }
  if (session && session.username === creds.username) return session
  let stored = creds.stored
  if (creds.legacy) {
    stored = await hashPassword(String(passwordRaw || ''))
    if (creds.promoterId) await updatePromoter(creds.promoterId, { password: stored })
  }
  session = {
    username: creds.username,
    role: creds.role,
    sessionId: uid(),
    loginAt: Date.now(),
    cred: { stored: stored || (await hashPassword(String(passwordRaw || ''))) },
  }
  persist()
  lastActivity = Date.now()
  await openBoxFor(session)
  await logAudit(session.username, 'auth.login', 'sesión', { role: session.role.id })
  return session
}

export async function logout() {
  if (session) {
    await logAudit(session.username, 'auth.logout', 'sesión', {})
    await closeBoxFor(session)
    session = null
  }
  localStorage.removeItem(KEY)
}

export async function resetAll() {
  window.location.hash = '#/login'
  session = null
  localStorage.removeItem(KEY)
  await resetFirebase()
}

export async function ensureOpenBox() {
  if (!session) return null
  return openBoxFor(session)
}