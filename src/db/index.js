import { ref, get, set, update, remove, onValue, runTransaction } from 'firebase/database'
import { db as rtdb } from '../firebase.js'

/*
 * Capa de datos sobre Firebase Realtime Database (sin Dexie).
 *
 * Cada tabla vive en un nodo RTDB con un registro por clave (`id`, o `key`
 * para `meta`). Mantiene un caché en memoria reactivo con `onValue`: cualquier
 * cambio hecho en cualquier dispositivo se refleja al instante. `audit` lee su
 * sub-nodo `audit/items` (la cadena de auditoría usa `audit/_tail`).
 */

const TABLES = [
  { name: 'catalog', keyField: 'id' },
  { name: 'orders', keyField: 'id' },
  { name: 'rentals', keyField: 'id' },
  { name: 'boxes', keyField: 'id' },
  { name: 'links', keyField: 'id' },
  { name: 'incidents', keyField: 'id' },
  { name: 'audit', keyField: 'id', path: 'audit/items' },
  { name: 'meta', keyField: 'key' },
]

const stores = new Map()
const colDef = (name) => TABLES.find((t) => t.name === name)

const clone = (r) => (r && typeof r === 'object' ? { ...r } : r)
const cmp = (a, b) => {
  const an = typeof a === 'number' ? a : Number(a)
  const bn = typeof b === 'number' ? b : Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  return String(a ?? '').localeCompare(String(b ?? ''))
}

/* ---------- Notificador global (debounced) ---------- */

const dataSubs = new Set()
let emitTimer = null
const notifyData = () => {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    dataSubs.forEach((cb) => {
      try {
        cb()
      } catch {
        /* noop */
      }
    })
  }, 250)
}

export const subscribeData = (cb) => {
  dataSubs.add(cb)
  return () => dataSubs.delete(cb)
}

/* ---------- Colección compatible con el subconjunto de Dexie usado ---------- */

function makeCollection(def) {
  const path = def.path || def.name
  const keyField = def.keyField
  let cache = []

  const notify = () => notifyData()

  const upsert = (key, rec) => {
    const i = cache.findIndex((r) => r[keyField] === key)
    if (i >= 0) cache[i] = { [keyField]: key, ...rec }
    else cache.push({ [keyField]: key, ...rec })
    notify()
  }

  const drop = (key) => {
    cache = cache.filter((r) => r[keyField] !== key)
    notify()
  }

  const rehydrate = async () => {
    const snap = await get(ref(rtdb, path))
    const rows = []
    if (snap.exists()) {
      snap.forEach((child) => {
        const v = child.val()
        if (v && typeof v === 'object') rows.push({ [keyField]: child.key, ...v })
      })
    }
    cache = rows
    notify()
  }

  const write = async (fn) => {
    try {
      await fn()
    } catch (e) {
      await rehydrate().catch(() => {})
      throw e
    }
  }

  const hyd = async () => rehydrate()

  const subscribe = () => {
    onValue(
      ref(rtdb, path),
      (snap) => {
        const rows = []
        if (snap.exists()) {
          snap.forEach((child) => {
            const v = child.val()
            if (v && typeof v === 'object') rows.push({ [keyField]: child.key, ...v })
          })
        }
        cache = rows
        notify()
      },
      () => {
        /* offline: se conserva el caché */
      }
    )
  }

  const self = {
    get path() {
      return path
    },
    get length() {
      return cache.length
    },
    async hydrate() {
      return hyd()
    },
    async subscribe() {
      return subscribe()
    },
    async get(key) {
      return clone(cache.find((r) => r[keyField] === key))
    },
    toArray() {
      return cache.map(clone)
    },
    first() {
      return clone(cache[0])
    },
    count() {
      return cache.length
    },
    async add(obj) {
      const key = obj?.[keyField]
      if (!key) throw new Error(`Falta id para ${def.name}`)
      upsert(key, obj)
      await write(() => set(ref(rtdb, `${path}/${key}`), obj))
      return key
    },
    async put(obj) {
      const key = obj?.[keyField]
      if (!key) throw new Error(`Falta id para ${def.name}`)
      upsert(key, obj)
      await write(() => set(ref(rtdb, `${path}/${key}`), obj))
    },
    async bulkAdd(objs) {
      for (const o of objs || []) await self.add(o)
    },
    async update(key, changes) {
      const rec = cache.find((r) => r[keyField] === key)
      if (rec) Object.assign(rec, clone(changes))
      else cache.push({ [keyField]: key, ...clone(changes) })
      notify()
      await write(() => update(ref(rtdb, `${path}/${key}`), changes))
    },
    async delete(key) {
      drop(key)
      await write(() => remove(ref(rtdb, `${path}/${key}`)))
    },
    async clear() {
      cache = []
      notify()
      await write(() => remove(ref(rtdb, path)))
    },
    upsert(key, rec) {
      upsert(key, rec)
    },
    where(key) {
      return {
        equals(val) {
          return {
            first: () => clone(cache.find((r) => r[key] === val)),
            toArray: () => cache.filter((r) => r[key] === val).map(clone),
            and(fn) {
              return {
                count: () => cache.filter((r) => r[key] === val && fn(r)).length,
                toArray: () => cache.filter((r) => r[key] === val && fn(r)).map(clone),
              }
            },
          }
        },
      }
    },
    orderBy(key) {
      const sortedDesc = (m = 1) =>
        [...cache].sort((a, b) => m * cmp(a[key], b[key]))
      return {
        toArray: () => sortedDesc(1).map(clone),
        reverse() {
          return {
            toArray: () => sortedDesc(-1).map(clone),
            first: () => clone(sortedDesc(-1)[0]),
            limit(n) {
              return { toArray: () => sortedDesc(-1).slice(0, n).map(clone) }
            },
          }
        },
      }
    },
    filter(fn) {
      return {
        toArray: () => cache.filter(fn).map(clone),
        count: () => cache.filter(fn).length,
        async delete() {
          const keys = cache.filter(fn).map((r) => r[keyField])
          cache = cache.filter((r) => !keys.includes(r[keyField]))
          notify()
          await write(() => Promise.all(keys.map((k) => remove(ref(rtdb, `${path}/${k}`)))))
        },
      }
    },
    async tx(updater) {
      const res = await runTransaction(ref(rtdb, path), (serverObj) => updater(serverObj || {}))
      if (res?.committed && res.snapshot) {
        const rows = []
        res.snapshot.forEach((child) => {
          const v = child.val()
          if (v && typeof v === 'object') rows.push({ [keyField]: child.key, ...v })
        })
        cache = rows
        notify()
      }
      return res
    },
    async txOne(key, updater) {
      const res = await runTransaction(ref(rtdb, `${path}/${key}`), (rec) => updater(rec || undefined))
      if (res?.committed && res.snapshot) {
        const v = res.snapshot.val()
        if (v) upsert(key, v)
        else drop(key)
      }
      return res
    },
  }

  return self
}

const getCol = (name) => {
  if (!stores.has(name)) stores.set(name, makeCollection(colDef(name)))
  return stores.get(name)
}

export const CATALOG = () => getCol('catalog')
export const ORDERS = () => getCol('orders')
export const RENTALS = () => getCol('rentals')
export const BOXES = () => getCol('boxes')
export const LINKS = () => getCol('links')
export const INCIDENTS = () => getCol('incidents')
export const AUDIT = () => getCol('audit')
export const META = () => getCol('meta')

/* ---------- Arranque ---------- */

export async function initData() {
  await Promise.all(
    TABLES.map(async (def) => {
      const col = getCol(def.name)
      await col.hydrate()
      col.subscribe()
    })
  )
}

export const checkConnection = () => get(ref(rtdb, 'meta/__conn'))

/* ---------- Reset ---------- */

export async function resetFirebase() {
  const nodes = ['catalog', 'orders', 'rentals', 'boxes', 'links', 'incidents', 'audit', 'meta']
  await Promise.all(nodes.map((n) => remove(ref(rtdb, n)).catch(() => {})))
  await import('./seed.js').then((m) => m.seed(true))
  const { resetPromotersFactory } = await import('../promoters/firebase-promoters.js')
  await resetPromotersFactory()
}