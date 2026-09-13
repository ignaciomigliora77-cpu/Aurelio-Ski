import { db } from './index.js'

async function migrateLegacy() {
  const snow = await db.catalog.where('id').equals('p03').first()
  if (snow && snow.category === 'botas' && snow.name === 'Bota de snow') {
    await db.catalog.update('p03', { category: 'botasSnow' })
  }
  const esqui = await db.catalog.filter((i) => /esquí/i.test(i.name || '')).toArray()
  for (const it of esqui) {
    await db.catalog.update(it.id, { name: it.name.replace(/esquí/gi, 'Ski') })
  }
}

const seedData = () => [
  { id: 'p01', order: 1, name: 'Bota de Ski', category: 'botasEsqui', price: 12000 },
  { id: 'p02', order: 2, name: 'Bota de nieve', category: 'botas', price: 13500 },
  { id: 'p03', order: 3, name: 'Bota de snow', category: 'botasSnow', price: 15000 },
  { id: 'p04', order: 4, name: 'Ski gama baja', category: 'esquies', price: 16000 },
  { id: 'p05', order: 5, name: 'Ski gama media', category: 'esquies', price: 23000 },
  { id: 'p06', order: 6, name: 'Ski gama alta', category: 'esquies', price: 34000 },
  { id: 'p07', order: 7, name: 'Pantalones', category: 'indumentaria', price: 9000 },
  { id: 'p08', order: 8, name: 'Camperas', category: 'indumentaria', price: 15000 },
  { id: 'p09', order: 9, name: 'Guantes', category: 'indumentaria', price: 5500 },
  { id: 'p10', order: 10, name: 'Antiparras', category: 'indumentaria', price: 7000 },
  { id: 'p11', order: 11, name: 'Casco', category: 'indumentaria', price: 9000 },
  { id: 'p12', order: 12, name: 'Snowboard', category: 'tabla', price: 22000 },
  { id: 'p13', order: 13, name: 'Bastones', category: 'bastones', price: 4000 },
]

export async function seed(force = false) {
  const count = await db.catalog.count()
  if (count > 0 && !force) {
    await migrateLegacy()
    return false
  }
  if (force) await db.catalog.clear()
  await db.catalog.bulkAdd(seedData())

  const hasPromoters = (await db.promoters.count()) > 0
  if (!hasPromoters) {
    await db.promoters.bulkAdd([
      { id: 'pr-1', username: 'promotor', password: 'Na212121', pct: 0, active: true, createdAt: Date.now() },
    ])
  }
  return true
}