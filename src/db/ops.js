import { ORDERS, RENTALS, INCIDENTS, META } from './index.js'
import { logAudit } from './audit.js'
import { assertToken } from '../ui/confirm.js'
import { categoryOf } from './categories.js'

/*
 * Número de bolsa correlativo 1–200 asignado en Recepción.
 * El contador se guarda de forma atómica en el nodo meta ('_bag') y vuelve
 * al 1 al reiniciarse cada temporada (resetFirebase borra todo el nodo meta).
 * Las órdenes históricas conservan su formato previo 'B-XXXXXX'.
 */
export const BAG_MAX = 200

export async function nextBagNumber() {
  let num = 0
  await META().txOne('_bag', (fresh) => {
    const cur = Number(fresh?.next || 0)
    num = (cur % BAG_MAX) + 1
    return { next: num }
  })
  return num
}

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
  const bag = await nextBagNumber()
  const rate = currency === 'ars' ? null : Number(rates?.[currency])
  const cur = rate ? +(Number(o.total) / rate).toFixed(2) : null
  if (currency !== 'ars' && !rate) throw fail('Falta el tipo de cambio de la divisa', 'RATE_REQUIRED')
  await ORDERS().txOne(orderId, (fresh) => {
    if (!fresh) throw fail('Venta no encontrada', 'NOT_FOUND')
    if (fresh.state !== 'pendiente' || fresh.bag) throw fail('La venta ya fue procesada', 'ALREADY')
    const at = Date.now()
    return {
      ...fresh,
      state: 'aprobada',
      currency,
      doc,
      bag,
      cashier: actor,
      approvedAt: at,
      validatedAt: at,
      rev: (fresh.rev || 0) + 1,
      fx: { rate, ars: fresh.total, cur },
    }
  })
  await logAudit(actor, 'venta.aprobar', o.code, { bag, currency, rate, cur, ars: o.total, itemQty: o.itemQty, client: o.clientName })
  return { code: o.code, bag }
}

/* ---------- Entregas (Rental) ---------- */

export async function deliverRows(rows, actor) {
  if (!rows.length) throw fail('Sin ítems para entregar', 'SIN_ITEMS')
  const orderCode = rows[0].orderCode
  const group = categoryOf(rows[0]?.category)?.group
  if (!group) throw fail('Falta la categoría de los ítems', 'CATEGORIA_REQUERIDA')
  const inconsistent = rows.some((r) => r.orderCode !== orderCode || categoryOf(r.category)?.group !== group)
  if (inconsistent) throw fail('Los ítems mezclan sectores distintos', 'MIXTO')
  const entry = { qty: rows.length, bag: rows[0]?.bag || null, group }
  await RENTALS().tx((map) => {
    const existing = Object.values(map).some(
      (r) => r && r.orderCode === orderCode && ACTIVE_RENTAL(r) && categoryOf(r.category)?.group === group
    )
    if (existing) throw fail('Este sector de la bolsa ya fue entregado', 'YA_ENTREGADO')
    for (const r of rows) map[r.id] = r
    return map
  })
  await logAudit(actor, 'rental.entregar', orderCode, entry)
  return orderCode
}

export async function reportReturn(rentalIds, actor) {
  const first = await RENTALS().get(rentalIds[0])
  const code = first?.orderCode || ''
  let n = 0
  await RENTALS().tx((map) => {
    const at = Date.now()
    let count = 0
    for (const id of rentalIds) {
      const r = map[id]
      if (r && r.status === 'out') {
        map[id] = { ...r, status: 'back', returnedBy: actor, returnAt: at }
        count += 1
      }
    }
    if (!count) throw fail('No hay ítems activos para reportar', 'NADA')
    n = count
    return map
  })
  await logAudit(actor, 'rental.reportar', code, { items: n })
  return n
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
  await INCIDENTS().add(inc)
  await logAudit(reportedBy, 'incidencia.crear', orderCode, { type, itemName: inc.itemName, qty: inc.qty })
  return inc.id
}

export async function confirmReturn(orderCode, actor) {
  const openInc = await INCIDENTS().where('orderCode').equals(orderCode).and((i) => i.status !== 'cerrado').toArray()
  if (openInc.length) {
    throw fail(`Hay ${openInc.length} incidencia(s) abierta(s) · cerrá el caso antes de liberar la orden`, 'INCIDENCIA_ABIERTA')
  }
  let closed = 0
  await RENTALS().tx((map) => {
    const at = Date.now()
    let count = 0
    for (const r of Object.values(map)) {
      if (r && r.orderCode === orderCode && r.status === 'back') {
        map[r.id] = { ...r, status: 'cerrado', confirmedBy: actor, confirmedAt: at }
        count += 1
      }
    }
    if (!count) throw fail('No hay devoluciones reportadas para cerrar', 'NADA')
    closed = count
    return map
  })
  await logAudit(actor, 'devolucion.cerrar', orderCode, { items: closed })
  return closed
}

export async function closeIncident(id, { amount, currency, paid, note, actor, token }) {
  const inc = await INCIDENTS().get(id)
  if (!inc) throw fail('Incidencia no encontrada', 'NOT_FOUND')
  if (!CURRENCIES.includes(String(currency || '').toLowerCase())) {
    throw fail('Seleccioná la moneda (ARS / USD / BRL)', 'CURRENCY_REQUIRED')
  }
  await assertToken(token, 'incidencia.cerrar', inc.orderCode)
  await INCIDENTS().txOne(id, (fresh) => {
    if (!fresh) throw fail('Incidencia no encontrada', 'NOT_FOUND')
    if (fresh.status === 'cerrado') throw fail('El caso ya fue cerrado', 'YA_CERRADO')
    return { ...fresh, status: 'cerrado', amount, currency, paid: !!paid, paidAt: Date.now(), paidBy: actor, note: note || fresh.note || '' }
  })
  await logAudit(actor, 'incidencia.cerrar', inc.orderCode, { id, type: inc.type, itemName: inc.itemName, amount, currency, paid: !!paid })
  return inc.orderCode
}

/* ---------- Eliminación / anulación de ventas ---------- */

export async function deleteSale(orderId, token, actor) {
  const o = await ORDERS().get(orderId)
  if (!o) throw fail('Venta no encontrada', 'NOT_FOUND')
  await assertToken(token, 'venta.eliminar', o.code)
  const delivered = await RENTALS().where('orderCode').equals(o.code).and(ACTIVE_RENTAL).count()
  await ORDERS().txOne(orderId, (fresh) => {
    if (!fresh) throw fail('Venta no encontrada', 'NOT_FOUND')
    const allowDelete = fresh.state === 'pendiente' || (fresh.state === 'aprobada' && delivered === 0)
    if (!allowDelete) throw fail('La venta tiene entregas físicas · usá la nota de anulación', 'FROZEN')
    return fresh
  })
  await ORDERS().delete(orderId)
  await logAudit(actor, 'venta.eliminar', o.code, { state: o.state, total: o.total })
  return o.code
}

export async function anularSale(orderId, { note, token, actor }) {
  const o = await ORDERS().get(orderId)
  if (!o) throw fail('Venta no encontrada', 'NOT_FOUND')
  await assertToken(token, 'venta.anular', o.code)
  await ORDERS().txOne(orderId, (fresh) => {
    if (!fresh) throw fail('Venta no encontrada', 'NOT_FOUND')
    if (fresh.state !== 'aprobada') throw fail('Solo se anulan ventas aprobadas ya congeladas', 'NO_ANULABLE')
    return { ...fresh, anulacionNote: { at: Date.now(), by: actor, note: note || '' } }
  })
  await logAudit(actor, 'venta.anular', o.code, { note: note || '', total: o.total })
  return o.code
}

/* ---------- Acción crítica genérica (con token firmado) ---------- */

export async function runCritical(token, action, target, fn) {
  await assertToken(token, action, target)
  return fn()
}