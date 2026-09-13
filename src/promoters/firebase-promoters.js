import { ref, get, set, update, remove, onValue, runTransaction } from 'firebase/database'
import { db as rtdb } from '../firebase.js'
import { hashPassword } from '../auth/crypto.js'

/*
 * Promotores — fuente de verdad en Firebase Realtime Database.
 *
 * Estructura: ref(db, 'promotores/<id>') => { id, username, password, pct,
 * active, createdAt, updatedAt }. `password` es SIEMPRE el hash PBKDF2.
 * El caché en memoria se actualiza con `onValue` (tiempo real entre
 * dispositivos) y el alta/renombre evita duplicados por usuario con una
 * transacción atómica.
 */

const NODE = 'promotores'

let cache = []
const subs = new Set()
let syncing = false

const normalize = (username) => String(username || '').trim().toLowerCase()

const emit = () => {
  const rows = [...cache]
  subs.forEach((cb) => {
    try {
      cb(rows)
    } catch {
      /* noop */
    }
  })
}

const fromSnapshot = (snap) => {
  const rows = []
  if (snap.exists()) {
    snap.forEach((child) => {
      const v = child.val()
      if (v && v.username) rows.push({ id: child.key, ...v })
    })
  }
  return rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

export const listPromoters = () => [...cache]

export const findByUsername = (username) => {
  const u = normalize(username)
  const found = cache.find((p) => p.username === u && p.active !== false)
  return found ? { ...found } : null
}

export const subscribePromoters = (cb) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

export async function startPromotersSync() {
  if (syncing) return
  syncing = true
  try {
    const snap = await get(ref(rtdb, NODE))
    cache = fromSnapshot(snap)
  } catch {
    cache = []
  }
  onValue(
    ref(rtdb, NODE),
    (snap) => {
      cache = fromSnapshot(snap)
      emit()
    },
    () => {
      /* offline */
    }
  )
  emit()
  return cache
}

export async function addPromoter({ id, username, password, pct }) {
  const u = normalize(username)
  if (!id || !u || !password) throw new Error('Datos de promotor incompletos')
  const stamp = Date.now()
  await runTransaction(ref(rtdb, NODE), (current) => {
    const map = current || {}
    const exists = Object.values(map).some((v) => v && normalize(v.username) === u)
    if (exists) throw new Error(`Ya existe el usuario ${u}`)
    map[id] = {
      id,
      username: u,
      password,
      pct: Number(pct) || 0,
      active: true,
      createdAt: stamp,
      updatedAt: stamp,
    }
    return map
  })
}

export async function updatePromoter(id, patch) {
  if (!id) return
  await update(ref(rtdb, `${NODE}/${id}`), { ...patch, updatedAt: Date.now() })
}

export async function removePromoter(id) {
  if (!id) return
  await remove(ref(rtdb, `${NODE}/${id}`))
}

async function factoryRow() {
  return {
    id: 'pr-default',
    username: 'promotor',
    password: await hashPassword('Na212121'),
    pct: 0,
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export async function ensureDefaultPromoter() {
  const snap = await get(ref(rtdb, NODE)).catch(() => null)
  if (snap && snap.exists()) return
  await set(ref(rtdb, `${NODE}/pr-default`), await factoryRow())
}

export async function resetPromotersFactory() {
  await remove(ref(rtdb, NODE)).catch(() => {})
  await set(ref(rtdb, `${NODE}/pr-default`), await factoryRow())
}