import { ref, get, update, remove } from 'firebase/database'
import { db } from '../firebase.js'
import { ORDERS, RENTALS, INCIDENTS, BOXES, LINKS, META } from './index.js'
import { logAudit } from './audit.js'

/*
 * Cierre de temporada + Histórico.
 *
 * Al cerrar la temporada se archiva TODO el dataset operativo activo en
 * /historico/{YYYY}/{MM}/ (orders, rentals, incidents, boxes, links) con un
 * resumen contable asociado. Tras el archivo se limpian las colecciones
 * activas y el contador de bolsa vuelve a 0 para la nueva temporada.
 * Catálogo, promotores y tipos de cambio se conservan.
 */

const indexBy = (rows, keyField) => {
  const out = {}
  for (const r of rows || []) out[r[keyField] || r.id] = r
  return out
}

const monthKey = (d = new Date()) => ({
  year: d.getFullYear(),
  month: String(d.getMonth() + 1).padStart(2, '0'),
})

export async function archiveSeason({ actor }) {
  const d = new Date()
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const base = `historico/${Y}/${M}`

  const existing = await get(ref(db, `${base}/_resumen`))
  if (existing.exists()) {
    const e = new Error(`El mes ${M}/${Y} ya está archivado`)
    e.code = 'ARCHIVADO'
    throw e
  }

  const [orders, rentals, incidents, boxes, links] = await Promise.all([
    ORDERS().toArray(),
    RENTALS().toArray(),
    INCIDENTS().toArray(),
    BOXES().toArray(),
    LINKS().toArray(),
  ])

  const revenue = orders
    .filter((o) => o.state === 'aprobada')
    .reduce((a, o) => a + Number(o.total || 0), 0)
  const itemQty = orders
    .filter((o) => o.state === 'aprobada')
    .reduce((a, o) => a + Number(o.itemQty || 0), 0)

  const payload = {
    orders: indexBy(orders, 'id'),
    rentals: indexBy(rentals, 'id'),
    incidents: indexBy(incidents, 'id'),
    boxes: indexBy(boxes, 'id'),
    links: indexBy(links, 'id'),
    _resumen: {
      spring: `${Y}/${M}`,
      year: Y,
      month: M,
      at: Date.now(),
      by: actor || 'recepcion',
      orders: orders.length,
      rentals: rentals.length,
      incidents: incidents.length,
      boxes: boxes.length,
      revenue,
      itemQty,
    },
  }

  await update(ref(db, base), payload)

  await Promise.all(
    ['orders', 'rentals', 'incidents', 'boxes', 'links'].map((n) =>
      remove(ref(db, n)).catch(() => {})
    )
  )
  /* Contador de bolsa a 0: la nueva temporada arranca en la bolsa 1. */
  await META().update('_bag', { next: 0 })

  await logAudit(actor || 'recepcion', 'temporada.cerrar', `${M}/${Y}`, {
    orders: orders.length,
    rentals: rentals.length,
    incidents: incidents.length,
    revenue,
  })

  return { year: Y, month: M, revenue, counts: payload._resumen }
}

export async function listSeasons() {
  const snap = await get(ref(db, 'historico'))
  const seasons = []
  if (snap.exists()) {
    snap.forEach((yearSnap) => {
      const year = yearSnap.key
      yearSnap.forEach((monthSnap) => {
        seasons.push({ year, month: monthSnap.key })
      })
    })
  }
  return seasons.sort((a, b) => `${a.year}/${a.month}`.localeCompare(`${b.year}/${b.month}`)).reverse()
}

export async function readMonth(year, month) {
  const base = `historico/${year}/${String(month).padStart(2, '0')}`
  const snap = await get(ref(db, base))
  if (!snap.exists()) return null
  const data = snap.val() || {}
  return {
    orders: Object.values(data.orders || {}),
    rentals: Object.values(data.rentals || {}),
    incidents: Object.values(data.incidents || {}),
    boxes: Object.values(data.boxes || {}),
    links: Object.values(data.links || {}),
    resumen: data._resumen || null,
  }
}

export const currentMonthKey = monthKey