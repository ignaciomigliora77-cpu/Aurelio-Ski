import { db, ORDERS, RENTALS, INCIDENTS } from './index.js'
import { buildAuditEntry } from './audit.js'
import { assertToken } from '../ui/confirm.js'

export const genBag = () =>
  'B-' + Math.random().toString(36).slice(2, 8).toUpperCase().replace(/0/g, 'K')

const fail = (msg, code) => {
  const e = new Error(msg)
  e.code = code
  return e
}

const CURRENCIES = ['ars', 'usd', 'brl']

const ACTIVE_RENTAL = (r) => ['out', 'back', 'cerrado'].includes(r.status)

/* ---------- Aprobación (Recepción) ---------- */

export async function approveOrder(orderId, { currency, doc, actor, rates }) {
  if (!CURRENCIES.includes(String(currency || '').toLowerCase())) {
    throw fail('Seleccioná la moneda de cobro (ARS / USD / BRL)', 'CURRENCY_REQUIRED')
  }
  const o = await ORDERS().get(orderId)
  if (!o) throw fail('Venta no encontrada', 'NOT_FOUND')
  if (o.state !== 'pendiente' || o.bag) throw fail('La venta ya fue procesada', 'ALREADY')
  const bag = genBag()
  const rate = currency === 'ars' ? null : Number(rates?.[currency])
  const cur = rate ? +(Number(o.total) / rate).toFixed(2) : null
  if (currency !== 'ars' && !rate) throw fail('Falta el tipo de cambio de la divisa', 'RATE_REQUIRED')
  const entry = await buildAuditEntry(actor, 'venta.aprobar', o.code, { bag, currency, rate, cur, ars: o.total, itemQty: o.itemQty, client: o.clientName })
  return db.transaction('rw', db.orders, db.audit_logs, async () => {
    const fresh = await ORDERS().get(orderId)
    if (!fresh) throw fail('Venta no encontrada', 'NOT_FOUND')
    if (fresh.state !== 'pendiente' || fresh.bag) throw fail('La venta ya fue procesada', 'ALREADY')
    const at = Date.now()
    await ORDERS().update(orderId, {
      state: 'aprobada',
      currency,
      doc,
      bag,
      cashier: actor,
      approvedAt: at,
      validatedAt: at,
      rev: (fresh.rev || 0) + 1,
      fx: { rate, ars: o.total, cur },
    })
    await db.audit_logs.add(entry)
    return { code: fresh.code, bag }
  })
}

/* ---------- Entregas (Rental) ---------- */

export async function deliverRows(rows, actor) {
  if (!rows.length) throw fail('Sin ítems para entregar', 'SIN_ITEMS')
  const orderCode = rows[0].orderCode
  const existing = await RENTALS().where('orderCode').equals(orderCode).and(ACTIVE_RENTAL).count()
  if (existing > 0) throw fail('Esta bolsa ya fue entregada', 'YA_ENTREGADO')
  const entry = await buildAuditEntry(actor, 'rental.entregar', orderCode, { qty: rows.length, bag: rows[0]?.bag || null })
  return db.transaction('rw', db.rentals, db.audit_logs, async () => {
    const freshExisting = await RENTALS().where('orderCode').equals(orderCode).and(ACTIVE_RENTAL).count()
    if (freshExisting > 0) throw fail('Esta bolsa ya fue entregada', 'YA_ENTREGADO')
    await RENTALS().bulkAdd(rows)
    await db.audit_logs.add(entry)
    return orderCode
  })
}

export async function reportReturn(rentalIds, actor) {
  const first = await RENTALS().get(rentalIds[0])
  const code = first?.orderCode || ''
  const entry = await buildAuditEntry(actor, 'rental.reportar', code, { items: rentalIds.length })
  return db.transaction('rw', db.rentals, db.audit_logs, async () => {
    const at = Date.now()
    let n = 0
    for (const id of rentalIds) {
      const r = await RENTALS().get(id)
      if (r && r.status === 'out') {
        await RENTALS().update(id, { status: 'back', returnedBy: actor, returnAt: at })
        n += 1
      }
    }
    if (!n) throw fail('No hay ítems activos para reportar', 'NADA')
    await db.audit_logs.add(entry)
    return n
  })
}

/* ---------- Incidencias ---------- */

export async function createIncident({ orderCode, type, itemName, qty, note, reportedBy }) {
  const inc = {
    id: (await import('../ui/components.js')).uid(),
    orderCode,
    type,
    itemName: itemName || '—',
    qty: qty || 1,
    note: note || '',
    reportedBy,
    status: 'abierto',
    at: Date.now(),
  }
  const entry = await buildAuditEntry(reportedBy, 'incidencia.crear', orderCode, { type, itemName: inc.itemName, qty: inc.qty })
  return db.transaction('rw', db.incidents, db.audit_logs, async () => {
    await INCIDENTS().add(inc)
    await db.audit_logs.add(entry)
    return inc.id
  })
}

export async function confirmReturn(orderCode, actor) {
  const backs = await RENTALS().where('orderCode').equals(orderCode).and((r) => r.status === 'back').toArray()
  if (!backs.length) throw fail('No hay devoluciones reportadas para cerrar', 'NADA')
  const entry = await buildAuditEntry(actor, 'devolucion.cerrar', orderCode, { items: backs.length })
  return db.transaction('rw', db.rentals, db.incidents, db.audit_logs, async () => {
    const freshBacks = await RENTALS().where('orderCode').equals(orderCode).and((r) => r.status === 'back').toArray()
    if (!freshBacks.length) throw fail('No hay devoluciones reportadas para cerrar', 'NADA')
    const openInc = await INCIDENTS().where('orderCode').equals(orderCode).and((i) => i.status !== 'cerrado').toArray()
    if (openInc.length) {
      throw fail(`Hay ${openInc.length} incidencia(s) abierta(s) · cerrá el caso antes de liberar la orden`, 'INCIDENCIA_ABIERTA')
    }
    const at = Date.now()
    await Promise.all(freshBacks.map((r) => RENTALS().update(r.id, { status: 'cerrado', confirmedBy: actor, confirmedAt: at })))
    await db.audit_logs.add(entry)
    return freshBacks.length
  })
}

export async function closeIncident(id, { amount, currency, paid, note, actor, token }) {
  const inc = await INCIDENTS().get(id)
  if (!inc) throw fail('Incidencia no encontrada', 'NOT_FOUND')
  if (!CURRENCIES.includes(String(currency || '').toLowerCase())) {
    throw fail('Seleccioná la moneda (ARS / USD / BRL)', 'CURRENCY_REQUIRED')
  }
  await assertToken(token, 'incidencia.cerrar', inc.orderCode)
  const entry = await buildAuditEntry(actor, 'incidencia.cerrar', inc.orderCode, { id, type: inc.type, itemName: inc.itemName, amount, currency, paid: !!paid })
  return db.transaction('rw', db.incidents, db.audit_logs, async () => {
    const fresh = await INCIDENTS().get(id)
    if (!fresh) throw fail('Incidencia no encontrada', 'NOT_FOUND')
    if (fresh.status === 'cerrado') throw fail('El caso ya fue cerrado', 'YA_CERRADO')
    await INCIDENTS().update(id, {
      status: 'cerrado',
      amount,
      currency,
      paid: !!paid,
      paidAt: Date.now(),
      paidBy: actor,
      note: note || fresh.note || '',
    })
    await db.audit_logs.add(entry)
    return fresh.orderCode
  })
}

/* ---------- Eliminación / anulación de ventas ---------- */

export async function deleteSale(orderId, token, actor) {
  const o = await ORDERS().get(orderId)
  if (!o) throw fail('Venta no encontrada', 'NOT_FOUND')
  await assertToken(token, 'venta.eliminar', o.code)
  const entry = await buildAuditEntry(actor, 'venta.eliminar', o.code, { state: o.state, total: o.total })
  return db.transaction('rw', db.orders, db.rentals, db.audit_logs, async () => {
    const fresh = await ORDERS().get(orderId)
    if (!fresh) throw fail('Venta no encontrada', 'NOT_FOUND')
    const delivered = await RENTALS().where('orderCode').equals(fresh.code).and(ACTIVE_RENTAL).count()
    const allowDelete = fresh.state === 'pendiente' || (fresh.state === 'aprobada' && delivered === 0)
    if (!allowDelete) throw fail('La venta tiene entregas físicas · usá la nota de anulación', 'FROZEN')
    await ORDERS().delete(orderId)
    await db.audit_logs.add(entry)
    return fresh.code
  })
}

export async function anularSale(orderId, { note, token, actor }) {
  const o = await ORDERS().get(orderId)
  if (!o) throw fail('Venta no encontrada', 'NOT_FOUND')
  await assertToken(token, 'venta.anular', o.code)
  const entry = await buildAuditEntry(actor, 'venta.anular', o.code, { note: note || '', total: o.total })
  return db.transaction('rw', db.orders, db.audit_logs, async () => {
    const fresh = await ORDERS().get(orderId)
    if (!fresh) throw fail('Venta no encontrada', 'NOT_FOUND')
    if (fresh.state !== 'aprobada') throw fail('Solo se anulan ventas aprobadas ya congeladas', 'NO_ANULABLE')
    await ORDERS().update(orderId, { anulacionNote: { at: Date.now(), by: actor, note: note || '' } })
    await db.audit_logs.add(entry)
    return fresh.code
  })
}

/* ---------- Acción crítica genérica (con token firmado) ---------- */

export async function runCritical(token, action, target, fn) {
  await assertToken(token, action, target)
  return fn()
}