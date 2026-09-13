import { AUDIT } from './index.js'
import { uid } from '../ui/components.js'

export const sha256hex = async (str) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function buildAuditEntry(actor, action, target, detail = {}) {
  const prev = await AUDIT().orderBy('at').reverse().first()
  const at = Date.now()
  const prevHash = prev?.hash || ''
  const payload = [prevHash, at, actor || '-', action, target || '', JSON.stringify(detail || {})].join('|')
  const hash = await sha256hex(payload)
  return { id: uid(), at, actor: actor || '-', action, target: target || '', detail: detail || {}, prevHash, hash }
}

export async function logAudit(actor, action, target, detail = {}) {
  const entry = await buildAuditEntry(actor, action, target, detail)
  await AUDIT().add(entry)
  return entry.hash
}

export async function verifyAudit() {
  const rows = await AUDIT().orderBy('at').toArray()
  let prevHash = ''
  const broken = []
  for (const r of rows) {
    const payload = [r.prevHash || '', r.at, r.actor, r.action, r.target || '', JSON.stringify(r.detail || {})].join('|')
    const h = await sha256hex(payload)
    const ok = r.prevHash === prevHash && h === r.hash
    if (!ok) broken.push(r.id)
    r._ok = ok
    prevHash = r.hash
  }
  return { rows, broken, intact: broken.length === 0 }
}