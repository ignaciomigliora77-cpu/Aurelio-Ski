import { getSession, logout } from '../../auth/index.js'
import { navigate } from '../../router.js'
import { icon } from '../../ui/icons.js'
import { money, esc, fmtDate, fmtTime, fmtDateTime, haptic } from '../../ui/components.js'
import { listSeasons, readMonth } from '../../db/historico.js'
import '../recepcion/recepcion.css'
import './historial.css'

const INC_LABEL = { rotura: 'Rotura', perdida: 'Pérdida', faltante: 'Faltante' }

const RENTAL_STATE = { out: 'En curso', back: 'Devuelto', cerrado: 'Cerrado' }

const monthName = (m) =>
  new Date(2000, Number(m) - 1, 1).toLocaleString('es-AR', { month: 'long' })

const orderState = (o) => {
  if (o.state === 'anulada' || o.anulacionNote) return '<span style="color:var(--red);font-weight:600">Anulada</span>'
  if (o.state === 'aprobada') return '<span style="color:var(--green);font-weight:600">Aprobada</span>'
  return '<span style="color:var(--orange);font-weight:600">Pendiente</span>'
}

const itemsTip = (o) => {
  try {
    return (o.items || []).map((i) => `${i.name} ×${i.qty || 1}`).join(' · ')
  } catch {
    return ''
  }
}

export function historialView() {
  let rootEl = null
  let panelEl = null
  let seasons = []
  let data = null
  let state = { year: null, month: null, tab: 'orders' }

  async function loadSeason(year, month) {
    if (!year || !month) return null
    try {
      return await readMonth(year, month)
    } catch {
      return null
    }
  }

  async function renderPanel() {
    if (!panelEl) return
    const res = data?.resumen

    if (!seasons.length) {
      panelEl.innerHTML = `
        <div class="recep-dash pop-in">
          <div class="empty" style="padding:60px 24px;text-align:center">
            ${icon('clock', 40, 2)}
            <h3 style="margin:14px 0 6px">Sin temporadas archivadas</h3>
            <p class="mutest">Al cerrar una temporada desde Recepción, el archivo aparece acá.</p>
          </div>
        </div>`
      return
    }

    const years = [...new Set(seasons.map((s) => s.year))].sort((a, b) => String(b).localeCompare(String(a)))
    const months = seasons.filter((s) => s.year === state.year)

    panelEl.innerHTML = `
      <div class="recep-dash pop-in">
        <div class="section-title">${icon('clock', 18, 2)} Temporadas</div>

        <div class="hist-bar">
          <label class="hist-field">
            <span>Año</span>
            <select id="hy">${years.map((y) => `<option value="${y}" ${String(y) === String(state.year) ? 'selected' : ''}>${y}</option>`).join('')}</select>
          </label>
          <label class="hist-field">
            <span>Mes</span>
            <select id="hm">${months.map((s) => `<option value="${s.month}" ${String(s.month) === String(state.month) ? 'selected' : ''}>${monthName(s.month)}</option>`).join('')}</select>
          </label>
          <div class="grow"></div>
          <div class="mutest">${months.length} temporada(s) archivada(s)</div>
        </div>

        ${res ? `
        <div class="metric-grid">
          <div class="metric metric--green">
            <span class="metric-label">Órdenes</span>
            <span class="metric-value">${res.orders ?? 0}</span>
            <span class="metric-hint">${res.itemQty ?? 0} ítems totales</span>
          </div>
          <div class="metric">
            <span class="metric-label">Entregas</span>
            <span class="metric-value">${res.rentals ?? 0}</span>
            <span class="metric-hint">${res.boxes ?? 0} bolsas armadas</span>
          </div>
          <div class="metric metric--orange">
            <span class="metric-label">Incidencias</span>
            <span class="metric-value">${res.incidents ?? 0}</span>
            <span class="metric-hint">cerradas y abiertas</span>
          </div>
          <div class="metric">
            <span class="metric-label">Recaudación</span>
            <span class="metric-value">${money(res.revenue ?? 0)}</span>
            <span class="metric-hint">ventas aprobadas · ${monthName(state.month)} ${state.year}</span>
          </div>
        </div>
        
        <div class="segmented hist-seg">
          <button data-t="orders" class="${state.tab === 'orders' ? 'on' : ''}">Órdenes (${data?.orders.length ?? 0})</button>
          <button data-t="rentals" class="${state.tab === 'rentals' ? 'on' : ''}">Entregas (${data?.rentals.length ?? 0})</button>
          <button data-t="incidents" class="${state.tab === 'incidents' ? 'on' : ''}">Incidencias (${data?.incidents.length ?? 0})</button>
        </div>

        <div class="card aud-card">
          <div class="aud-wrap">
            ${renderTable()}
          </div>
        </div>` : `
        <div class="card aud-card" style="margin-top:14px">
          <div class="empty" style="padding:30px 20px;text-align:center">
            La temporada ${monthName(state.month)} ${state.year} todavía no tiene datos archivados.
          </div>
        </div>`}
      </div>
    `

    const hy = panelEl.querySelector('#hy')
    const hm = panelEl.querySelector('#hm')
    if (hy) {
      hy.addEventListener('change', async () => {
        state.year = String(hy.value)
        const ms = seasons.filter((s) => s.year === state.year)
        state.month = ms[0]?.month ?? null
        state.tab = 'orders'
        data = await loadSeason(state.year, state.month)
        haptic(8)
        renderPanel()
      })
    }
    if (hm) {
      hm.addEventListener('change', async () => {
        state.month = String(hm.value)
        state.tab = 'orders'
        data = await loadSeason(state.year, state.month)
        haptic(8)
        renderPanel()
      })
    }
    panelEl.querySelectorAll('.hist-seg button').forEach((b) => {
      b.addEventListener('click', async () => {
        state.tab = b.dataset.t
        haptic(6)
        renderPanel()
      })
    })
  }

  function renderTable() {
    if (state.tab === 'orders') {
      const rows = data?.orders || []
      if (!rows.length) return '<div class="empty" style="padding:24px">Sin órdenes en este mes.</div>'
      return `
        <table class="aud-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Código</th>
              <th>Cliente</th>
              <th>Promotor</th>
              <th>Bolsa</th>
              <th>Ítems</th>
              <th>Divisa</th>
              <th>Total</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${[...rows].sort((a, b) => (Number(b.approvedAt || b.createdAt || 0)) - (Number(a.approvedAt || a.createdAt || 0))).map((o) => `
              <tr>
                <td class="mono">${fmtDateTime(o.approvedAt || o.createdAt || 0)}</td>
                <td class="mono">${esc(o.code || '—')}</td>
                <td title="${esc(itemsTip(o))}">${esc(o.clientName || '—')}</td>
                <td class="mono">${esc(o.promoterId || '—')}</td>
                <td class="mono">${o.bag ? esc(o.bag) : '—'}</td>
                <td class="mono">${o.itemQty ?? (o.items?.length ?? 0)}</td>
                <td>${esc((o.currency || '—').toUpperCase())}</td>
                <td class="mono">${money(o.total || 0)}</td>
                <td>${orderState(o)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
    }

    if (state.tab === 'rentals') {
      const rows = data?.rentals || []
      if (!rows.length) return '<div class="empty" style="padding:24px">Sin entregas en este mes.</div>'
      return `
        <table class="aud-table">
          <thead>
            <tr>
              <th>Fecha entrega</th>
              <th>Orden</th>
              <th>Cliente</th>
              <th>Artículo</th>
              <th>Cantidad</th>
              <th>Bolsa</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${[...rows].sort((a, b) => Number(b.outAt || 0) - Number(a.outAt || 0)).map((r) => `
              <tr>
                <td class="mono">${fmtDateTime(r.outAt || 0)}</td>
                <td class="mono">${esc(r.orderCode || '—')}</td>
                <td>${esc(r.clientName || '—')}</td>
                <td>${esc(r.name || '—')}</td>
                <td class="mono">×${r.qty ?? 1}</td>
                <td class="mono">${r.bag ? esc(r.bag) : '—'}</td>
                <td>${RENTAL_STATE[r.status] || esc(r.status || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
    }

    const rows = data?.incidents || []
    if (!rows.length) return '<div class="empty" style="padding:24px">Sin incidencias en este mes.</div>'
    return `
      <table class="aud-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Orden</th>
            <th>Tipo</th>
            <th>Artículo</th>
            <th>Cantidad</th>
            <th>Nota</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${[...rows].sort((a, b) => Number(b.at || 0) - Number(a.at || 0)).map((i) => `
            <tr>
              <td class="mono">${fmtDateTime(i.at || i.createdAt || 0)}</td>
              <td class="mono">${esc(i.orderCode || '—')}</td>
              <td>${esc(INC_LABEL[i.type] || i.type || '—')}</td>
              <td>${esc(i.itemName || '—')}</td>
              <td class="mono">×${i.qty ?? 1}</td>
              <td>${esc(i.note || '—')}</td>
              <td>${i.status === 'cerrado'
                ? '<span style="color:var(--green);font-weight:600">Cerrado</span>'
                : '<span style="color:var(--orange);font-weight:600">Abierto</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
  }

  const mount = async (root) => {
    rootEl = root
    const s = getSession()
    try {
      seasons = await listSeasons()
    } catch {
      seasons = []
    }
    const latest = seasons[0]
    if (latest) {
      state.year = String(latest.year)
      state.month = String(latest.month)
      data = await loadSeason(state.year, state.month)
    }

    root.innerHTML = `
      <div class="screen screen--dash hist-shell">
        <main class="panel">
          <div class="page-head">
            <div class="grow">
              <div class="eyebrow">${fmtDate(Date.now())} · ${esc(s.role.short)}</div>
              <h2>Historial de temporadas</h2>
            </div>
            <button class="btn btn--sm btn--ghost" id="hist-logout" type="button">Cerrar Sesión</button>
          </div>
          <div class="body-pad" id="hist-panel"></div>
        </main>
      </div>
    `
    panelEl = root.querySelector('#hist-panel')
    root.querySelector('#hist-logout').addEventListener('click', async () => {
      haptic(10)
      await logout()
      navigate('login', true)
    })
    await renderPanel()
  }

  const unmount = () => {
    rootEl = null
    panelEl = null
  }

  return { mount, unmount }
}