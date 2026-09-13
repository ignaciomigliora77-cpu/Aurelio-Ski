export const CATEGORIES = {
  botasEsqui: { label: 'Botas de Ski', icon: 'box', tone: 'purple', order: 0, group: 'botas' },
  botasSnow: { label: 'Botas de snow', icon: 'box', tone: 'orange', order: 1, group: 'botas' },
  botas: { label: 'Botas de nieve', icon: 'box', tone: 'green', order: 2, group: 'ropa' },
  esquies: { label: 'Skis', icon: 'box', tone: 'accent', order: 3, group: 'equipo' },
  indumentaria: { label: 'Indumentaria', icon: 'box', tone: 'green', order: 4, group: 'ropa' },
  tabla: { label: 'Tablas', icon: 'box', tone: 'purple', order: 5, group: 'equipo' },
  bastones: { label: 'Bastones', icon: 'box', tone: 'red', order: 6, group: 'equipo' },
}

export const CATEGORY_IDS = Object.keys(CATEGORIES)

export const categoryOf = (id) => CATEGORIES[id] || { label: 'Otros', icon: 'box', tone: 'accent', group: 'equipo' }

export const categoriesOfGroup = (group) =>
  Object.entries(CATEGORIES)
    .filter(([, c]) => c.group === group)
    .sort((a, b) => a[1].order - b[1].order)