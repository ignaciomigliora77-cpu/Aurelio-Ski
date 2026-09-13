/* Depuración temporal · limpieza del registro de prueba "prueba uno"
 *
 * Uso: abrí la app Aurelio SKI, pegá TODO este bloque en la consola del navegador
 * (DevTools → Console) y Enter. Primero hace una inspección (NO borra nada) y
 * deja disponible __aurelio.scrub(orderId) para eliminar la venta con su borrador
 * físico (rentals) e incidencias en una sola transacción, con auditoría encadenada.
 *
 * - No toca la tabla `promoters`.
 * - No modifica el código de la app ni requiere rebuild.
 * - Forrá 1: todos estos comandos solo tocan la base IndexedDB del mismo origen.
 */
;(async () => {
  'use strict'

  const DB_NAME = 'aurelio-ski'
  const RX = /prueba/i
  const VALID_STATES = ['pendiente', 'aprobada']

  const openDB = () =>
    new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME)
      req.onsuccess = () => {
        const d = req.result
        d.onversionchange = () => d.close()
        res(d)
      }
      req.onerror = () => rej(req.error)
    })

  const getAll = (db, store) =>
    new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll()
      r.onsuccess = () => res(r.result || [])
      r.onerror = () => rej(r.error)
    })

  const sha256hex = async (str) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const uid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)

  const fmt = (n) => '$ ' + Math.round(n || 0).toLocaleString('es-AR')
  const fmtT = (t) => (t ? new Date(t).toLocaleString('es-AR') : '—')

  if (!window.indexedDB) throw new Error('IndexedDB no disponible en este contexto')

  const db = await openDB()
  const stores = [...db.objectStoreNames]
  if (!stores.includes('orders')) throw new Error('La base no tiene la tabla orders')

  const orders = await getAll(db, 'orders')
  const rentals = await getAll(db, 'rentals')
  const incidents = stores.includes('incidents') ? await getAll(db, 'incidents') : []
  const promoters = stores.includes('promoters') ? await getAll(db, 'promoters') : []

  const rel = (code) => ({
    rentals: rentals.filter((r) => r.orderCode === code),
    incidents: incidents.filter((i) => i.orderCode === code),
  })

  const approvedBefore = orders.filter((o) => o.state === 'aprobada')
  const sumBefore = approvedBefore.reduce((a, o) => a + Number(o.total || 0), 0)

  const foundByRx = orders.filter(
    (o) => RX.test(o.promoterId || '') || RX.test(o.code || '') || RX.test(o.clientName || '')
  )
  const weirdStates = orders.filter((o) => !VALID_STATES.includes(o.state))

  console.log('=== AURELIO · INSPECCIÓN (dry-run, no se borró nada) ===')
  console.log('Totales actuales:', { aprobadas: approvedBefore.length, recaudacion: fmt(sumBefore) })

  const pico = (o) => ({
    id: o.id,
    code: o.code,
    state: o.state,
    promoter: o.promoterId,
    client: o.clientName || '',
    createdAt: fmtT(o.createdAt),
    approvedAt: fmtT(o.approvedAt),
    total: o.total,
    currency: o.currency || 'ars',
    bag: o.bag || '',
    ...(o.fx ? { fx: o.fx } : {}),
    rentals: rel(o.code).rentals.length,
    incidents: rel(o.code).incidents.length,
  })

  console.log('--- pedidos con "prueba" en code/client/promoter ---')
  console.table(foundByRx.map(pico))
  console.log('--- pedidos con state raro (fuera de pendiente/aprobada) ---')
  console.table(weirdStates.map(pico))
  console.log('--- filas de la tabla promoters con "prueba" (NO se tocan) ---')
  console.table(promoters.filter((p) => RX.test(p.username || '')).map((p) => ({ id: p.id, username: p.username, pct: p.pct, active: p.active, createdAt: fmtT(p.createdAt) })))

  console.log(`
Si encontraste la venta, usá:
  __aurelio.scrub(<orderId>)          → elimina UNA venta (con rentals + incidents + auditoría)
  __aurelio.scrub(<orderId>, false)   → borra solo la orden, sin rentals/incidents (no recomendado)
`)

  window.__aurelio = {
    db,
    scan: () => ({ foundByRx, weirdStates }),
    scrub: async (orderId, withLinked = true) => {
      let o = orders.find((x) => x.id === orderId)
      if (!o) {
        const rxOnly = foundByRx
        if (rxOnly.length === 1) o = rxOnly[0]
        else throw new Error(orderId ? 'ID no encontrado' : 'Hay más de un candidato · pasá el id (ver consola)')
      }
      const code = o.code
      const linked = rel(code)
      console.log(`Objetivo: ${code} (state=${o.state}) · rentals=${linked.rentals.length} · incidents=${linked.incidents.length} · total=${fmt(o.total)}`)
      const keep = 'BORRAR'
      const typed = prompt(`Se eliminará PERMANENTEMENTE la venta ${code}${withLinked ? ' y su borrador físico (' + linked.rentals.length + ' rental/s) e incidentes (' + linked.incidents.length + ')' : ''}.\n\nEscribí ${keep} (en mayúsculas) para confirmar:`)
      if (typed !== keep) {
        console.warn('Abortado · no se borró nada')
        return false
      }
      const actor = prompt('Operador que autoriza (queda en auditoría):', 'recepcion') || 'recepcion'

      const db2 = await openDB()
      const logs = await getAll(db2, 'audit_logs')
      logs.sort((a, b) => a.at - b.at)
      const prev = logs[logs.length - 1]
      const at = Date.now()
      const detail = {
        state: o.state,
        total: o.total,
        currency: o.currency || 'ars',
        rentals: withLinked ? linked.rentals.length : 0,
        incidents: withLinked ? linked.incidents.length : 0,
        reason: 'limpieza manual de datos de prueba',
      }
      const hash = await sha256hex([prev?.hash || '', at, actor, 'depuracion.eliminar', code, JSON.stringify(detail)].join('|'))
      const entry = { id: uid(), at, actor, action: 'depuracion.eliminar', target: code, detail, prevHash: prev?.hash || '', hash }

      await new Promise((res, rej) => {
        const t = db2.transaction(['orders', 'rentals', 'incidents', 'audit_logs'], 'readwrite')
        const os = t.objectStore('orders')
        const rs = t.objectStore('rentals')
        const inc = t.objectStore('incidents')
        os.delete(o.id)
        if (withLinked) {
          linked.rentals.forEach((r) => rs.delete(r.id))
          linked.incidents.forEach((i) => inc.delete(i.id))
        }
        t.objectStore('audit_logs').add(entry)
        t.oncomplete = () => res()
        t.onerror = () => rej(t.error)
        t.onabort = () => rej(t.error)
      })

      const rest = await getAll(db2, 'orders')
      const ap = rest.filter((x) => x.state === 'aprobada')
      const sum = ap.reduce((a, x) => a + Number(x.total || 0), 0)
      const still = rest.filter((x) => RX.test(x.code || '') || RX.test(x.promoterId || '') || RX.test(x.clientName || ''))
      console.log(`OK · venta ${code} eliminada (con auditoría ${entry.hash.slice(0, 10)}…)`)
      console.log('Nuevos totales:', { aprobadas: ap.length, recaudacion: fmt(sum) })
      console.log(still.length ? 'Quedan coincidencias de "prueba": ' + still.map((s) => s.code).join(', ') : 'Sin coincidencias de "prueba".')
      console.log('Recargá la app (F5) y revisá Economía / Reportes / Ventas "Todo" / Auditoría (cadena debe seguir intacta).')
      return true
    },
  }
})()