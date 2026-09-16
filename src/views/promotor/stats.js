import { ORDERS, subscribeData } from '../../db/index.js'
import { getSession } from '../../auth/index.js'
import { money, fmtDate } from '../../ui/components.js'

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

async function weekChart() {
  const s = getSession()
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const days = []
  for (let i = 6; i >= 0; i--) {
    const t = startOfToday - i * 864e5
    days.push({ t, label: fmtDate(t), total: 0 })
  }
  const all = await ORDERS().toArray()
  for (const o of all) {
    if (o.promoterId !== s.username || o.state !== 'aprobada' || !o.createdAt) continue
    for (const d of days) {
      if (o.createdAt >= d.t && o.createdAt < d.t + 864e5) {
        d.total += o.total
        break
      }
    }
  }
  return days
}

function chartHTML(days) {
  const max = Math.max(1, ...days.map((d) => d.total))
  return `
    <div class="stats-chart card">
      <div class="eyebrow">Últimos 7 días</div>
      <p class="mutest" style="font-size:12px;margin-top:2px">Tus ventas aprobadas día por día</p>
      <div class="stats-bars">
        ${days.map((d) => `
          <div class="stats-bar" title="${d.label} · ${money(d.total)}">
            <div class="stats-bar-track"><div class="stats-bar-fill" style="height:${d.total ? Math.round((d.total / max) * 100) : 0}%"></div></div>
            <span class="stats-bar-label">${d.label}</span>
          </div>`).join('')}
      </div>
    </div>`
}

export function statsView() {
  let dataOff = null
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
      const days = await weekChart()

      root.querySelector('#stats-metrics').innerHTML = `
        <div class="metric-grid">
          ${metricCard('Recaudación total', money(revenue), 'accent', 'suma de tus ventas aprobadas')}
          ${metricCard('Ventas aprobadas', orders.length, '', 'registradas por Recepción')}
        </div>
        ${chartHTML(days)}
      `
    }

    await paint()

    dataOff?.()
    dataOff = subscribeData(() => {
      if (root.isConnected) paint()
    })
  }

  return { mount, unmount() { dataOff?.(); dataOff = null } }
}