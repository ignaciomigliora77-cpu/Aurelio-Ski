import { ORDERS } from '../../db/index.js'
import { getSession } from '../../auth/index.js'
import { money } from '../../ui/components.js'

const RANGES = {
  hoy: { label: 'Hoy', from: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() } },
  '7dias': { label: '7 días', from: () => Date.now() - 7 * 864e5 },
  mes: { label: 'Este mes', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime() } },
}

let state = { range: 'hoy' }

async function loadStats(range) {
  const s = getSession()
  const from = RANGES[range].from()
  const all = await ORDERS().toArray()
  return all
    .filter((o) => o.promoterId === s.username && o.state === 'aprobada' && o.createdAt >= from)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function metricCard(label, value, tone = '', sub = '') {
  return `
    <div class="metric metric--${tone}">
      <span class="metric-label">${label}</span>
      <span class="metric-value">${value}</span>
      ${sub ? `<span class="metric-hint">${sub}</span>` : ''}
    </div>`
}

export function statsView() {
  const mount = async (root) => {
    root.innerHTML = `
      <div class="stats stack">
        <div class="segmented" id="range-seg">
          ${Object.entries(RANGES).map(([id, r]) => `<button data-range="${id}" class="${state.range === id ? 'on' : ''}">${r.label}</button>`).join('')}
        </div>
        <div id="stats-metrics"></div>
        <p class="mutest" style="font-size:12px;text-align:center">Ventas propias del turno · ${RANGES[state.range].label}</p>
      </div>
    `

    root.querySelectorAll('[data-range]').forEach((b) => {
      b.addEventListener('click', async () => {
        state.range = b.dataset.range
        root.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b))
        await paint()
      })
    })

    async function paint() {
      const orders = await loadStats(state.range)
      const revenue = orders.reduce((a, o) => a + o.total, 0)

      root.querySelector('#stats-metrics').innerHTML = `
        <div class="metric-grid">
          ${metricCard('Recaudación total', money(revenue), 'accent', 'suma de tus ventas aprobadas')}
          ${metricCard('Ventas aprobadas', orders.length, '', 'registradas por Recepción')}
        </div>
      `
    }

    await paint()
  }

  return { mount, unmount() {} }
}