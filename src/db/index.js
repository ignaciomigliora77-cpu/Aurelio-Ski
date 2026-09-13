import Dexie from 'dexie'

export const db = new Dexie('aurelio-ski')

db.version(1).stores({
  catalog: 'id, name, category, price',
  orders: 'id, code, sessionId, promoterId, itemQty, total, createdAt, validatedAt',
  rentals: 'id, productId, name, size, status, sessionId, outAt, returnAt',
  boxes: 'id, sessionId, openedBy, openedAt, closedAt',
  meta: 'key',
})

db.version(2).stores({
  catalog: 'id, name, category, price',
  orders: 'id, code, sessionId, promoterId, itemQty, total, createdAt, validatedAt',
  rentals: 'id, productId, name, size, status, sessionId, outAt, returnAt',
  boxes: 'id, sessionId, openedBy, openedAt, closedAt, closingTotal',
  meta: 'key',
})

db.version(5).stores({
  catalog: 'id, name, category, price',
  orders: 'id, code, sessionId, promoterId, itemQty, total, state, createdAt, validatedAt, approvedAt',
  rentals: 'id, orderCode, productId, name, category, status, sessionId, operatorId, outAt, returnAt',
  boxes: 'id, sessionId, openedBy, openedAt, closedAt, closingTotal',
  links: 'id, desk, promoterId, at',
  meta: 'key',
})

db.version(6).stores({
  catalog: 'id, name, category, price',
  orders: 'id, code, sessionId, promoterId, itemQty, total, state, createdAt, validatedAt, approvedAt',
  rentals: 'id, orderCode, productId, name, category, status, sessionId, operatorId, outAt, returnAt',
  boxes: 'id, sessionId, openedBy, openedAt, closedAt, closingTotal',
  links: 'id, desk, promoterId, at',
  promoters: 'id, username, password, pct, active, createdAt',
  meta: 'key',
})

db.version(8).stores({
  catalog: 'id, name, category, price',
  orders: 'id, code, sessionId, promoterId, itemQty, total, state, createdAt, validatedAt, approvedAt',
  rentals: 'id, orderCode, productId, name, category, status, sessionId, operatorId, outAt, returnAt',
  boxes: 'id, sessionId, openedBy, openedAt, closedAt, closingTotal',
  links: 'id, desk, promoterId, at',
  promoters: 'id, username, password, pct, active, createdAt',
  incidents: 'id, orderCode, type, itemName, qty, status, at, reportedBy',
  audit_logs: 'id, at, actor, action, target',
  meta: 'key',
})

export const CATALOG = () => db.catalog
export const ORDERS = () => db.orders
export const RENTALS = () => db.rentals
export const BOXES = () => db.boxes
export const LINKS = () => db.links
export const PROMOTER_DB = () => db.promoters
export const INCIDENTS = () => db.incidents
export const AUDIT = () => db.audit_logs
export const META = () => db.meta

export async function resetData() {
  await db.delete()
  await db.open()
  await import('./seed.js').then((m) => m.seed())
}