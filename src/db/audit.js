import { ref, runTransaction } from 'firebase/database'
import { db as rtdb } from '../firebase.js'
import { AUDIT } from './index.js'
import { uid } from '../ui/components.js'
import { deviceSnap } from '../ui/device.js'

/*
 * Auditoría append-only con cadena de integridad GLOBAL.
 *
 * Se usa un único nodo `audit` con `_tail {seq, hash}` y `items/<seq>`.
 * Cada entrada se agrega dentro de una transacción atómica sobre el nodo:
 * dos dispositivos que escriben en paralelo quedan serializados por RTDB y la
 * cadena nunca se bifurca. El hash es síncrono (FNV-1a 64) porque la
 * transacción no puede esperar primitivas asíncronas.
 */

const AUDIT_PATH = 'audit'

const fnv1a = (str) => {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b1
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 16777619)
    h2 = Math.imul(h2 ^ ch, 1099511628211)
  }
  h1 = Math.imul(h1 >>> 0, 1)
  h2 = Math.imul(h2 >>> 0, 1)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

export const sha256hex = async (str) => fnv1a(str)

export const hashOf = (prevHash, at, actor, action, target, detail) =>
  fnv1a([prevHash, at, actor || '-', action || '', target || '', JSON.stringify(detail || {})].join('|'))

export async function logAudit(actor, action, target, detail = {}) {
  /* El snapshot de dispositivo se anexa primero para que el detalle del
     llamador tenga prioridad. Entra dentro de la cadena de hash: verifyAudit
     lo re-computa desde los datos guardados sin romper la integridad. */
  detail = { ...deviceSnap(), ...detail }
  let entry = null
  await runTransaction(ref(rtdb, AUDIT_PATH), (cur) => {
    cur = cur || {}
    const items = cur.items || {}
    const tail = cur._tail || { seq: 0, hash: '' }
    const seq = (tail.seq || 0) + 1
    const at = Date.now()
    const e = {
      id: uid(),
      seq,
      at,
      actor: actor || '-',
      action,
      target: target || '',
      detail: detail || {},
      prevHash: tail.hash || '',
      hash: hashOf(tail.hash, at, actor, action, target, detail),
    }
    items[String(seq)] = e
    cur.items = items
    cur._tail = { seq, hash: e.hash }
    entry = e
    return cur
  })
  if (entry) AUDIT().upsert(entry.id, entry)
  return entry?.hash || ''
}

export async function verifyAudit() {
  const rows = await AUDIT().toArray()
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0) || (a.at || 0) - (b.at || 0))
  let prevHash = ''
  const broken = []
  for (const r of rows) {
    const h = hashOf(r.prevHash || '', r.at, r.actor, r.action, r.target || '', r.detail || {})
    const ok = (r.prevHash || '') === prevHash && h === r.hash
    if (!ok) broken.push(r.id)
    r._ok = ok
    prevHash = r.hash
  }
  return { rows, broken, intact: broken.length === 0 }
}