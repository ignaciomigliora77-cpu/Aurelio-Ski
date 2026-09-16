import { ORDERS, RENTALS, CATALOG, META, INCIDENTS, AUDIT, subscribeData } from '../../db/index.js'
import { CATEGORIES, CATEGORY_IDS, categoryOf } from '../../db/categories.js'
import { getSession, logout, listPromoters, resetAll } from '../../auth/index.js'
import { addPromoter, updatePromoter, removePromoter, subscribePromoters } from '../../promoters/firebase-promoters.js'
import { navigate } from '../../router.js'
import { icon } from '../../ui/icons.js'
import { mountDock } from '../../components/Dock.js'
import { openDetail } from '../../components/ModalDetail.js'
import { money, esc, fmtTime, fmtDate, fmtDateTime, ok, haptic, err, uid, openSheet, openPopover, animateOut, titleCase } from '../../ui/components.js'
import { cleanText, slugUser, passValid, cleanDoc, cleanMoney, cleanInt } from '../../ui/sanitize.js'
import { logAudit, verifyAudit } from '../../db/audit.js'
import { approveOrder, confirmReturn, closeIncident, deleteSale, anularSale, runCritical } from '../../db/ops.js'
import { archiveSeason } from '../../db/historico.js'
import { confirmCritical } from '../../ui/confirm.js'
import './recepcion.css'

const SECTIONS = [
  { id: 'resumen', label: 'Resumen', icon: 'house' },
  { id: 'aprobacion', label: 'Aprobación', icon: 'check' },
  { id: 'inventario', label: 'Inventario', icon: 'box' },
  { id: 'ventas', label: 'Ventas', icon: 'list' },
  { id: 'economia', label: 'Economía', icon: 'cards' },
  { id: 'reportes', label: 'Reportes', icon: 'chart' },
  { id: 'auditoria', label: 'Auditoría', icon: 'clock' },
]

let rootEl = null
let panelEl = null
let section = 'aprobacion'
let apTab = 'aprobar'
let syncOff = null
let orders = []
let rentals = []
let catalog = []
let promoters = []
let incidents = []
let lastPending = -1
let ticker = null
let state = {
  q: '',
  period: 'hoy',
  rates: { usd: 1200, brl: 220 },
}
const curSel = {}

const isEditableFocused = () => {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable
}

const startOfDay = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const isApproved = (o) => o.state === 'aprobada'

/* Borrado lógico sin excepción: una venta anulada desaparece de las listas
   activas pero queda asentada en el historial y la auditoría. */
const isAnulada = (o) => o.state === 'anulada' || !!o.anulacionNote

const pending = () => orders.filter((o) => !isApproved(o) && !isAnulada(o))

const fxRate = (k) => (k === 'usd' ? state.rates.usd : state.rates.brl)

const fmtFx = (k, total) => {
  if (k === 'ars') return money(total)
  const n = total / fxRate(k)
  return (k === 'usd' ? 'US$ ' : 'R$ ') + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CUR_OPTS = [
  ['ars', 'ARS $'],
  ['usd', 'USD'],
  ['brl', 'BRL'],
]

const INC_LABEL = { rotura: 'Rotura', perdida: 'Pérdida', faltante: 'Faltante' }

const hasDeliveries = (o) => rentals.some((r) => r.orderCode === o.code && ['out', 'back', 'cerrado'].includes(r.status))

const deletable = (o) => o.state === 'pendiente' || (o.state === 'aprobada' && !hasDeliveries(o))

const openIncidents = (orderCode) => incidents.filter((i) => i.orderCode === orderCode && i.status !== 'cerrado')

/* Solo aparece una devolución cuando el cliente terminó TODA su entrega:
   al menos un rental reportado en 'back' y ningún 'out' pendiente de la orden. */
const backGroups = () => {
  const seen = new Map()
  for (const r of rentals.filter((x) => x.status === 'back')) {
    if (seen.has(r.orderCode)) continue
    const stillOut = rentals.some((x) => x.orderCode === r.orderCode && x.status === 'out')
    if (!stillOut) seen.set(r.orderCode, r)
  }
  return [...seen.values()].sort((a, b) => (b.returnAt || 0) - (a.returnAt || 0))
}

async function getMeta(key, def = null) {
  const row = await META().get(key)
  return row?.value ?? def
}

async function setMeta(key, value) {
  await META().put({ key, value })
}

async function load() {
  orders = await ORDERS().toArray()
  rentals = await RENTALS().toArray()
  catalog = await CATALOG().toArray()
  promoters = await listPromoters()
  incidents = await INCIDENTS().toArray()
  state.rates = { usd: 1200, brl: 220, ...(await getMeta('rates', {})) }
}

const approvedToday = () => orders.filter((o) => isApproved(o) && (o.approvedAt || o.createdAt) >= startOfDay())

const arsEqOf = (o) => Number(o.fx?.ars) || o.total

const amountOf = (o) => {
  const cur = o.currency || 'ars'
  if (cur === 'ars') return money(o.total)
  if (o.fx?.rate) {
    const sym = cur === 'usd' ? 'US$ ' : 'R$ '
    const rate = Number(o.fx.rate).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const fxAmt = Number(o.fx.cur).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const eq = Number(o.fx.ars) ? ` · ≈ ${money(o.fx.ars)} ARS` : ''
    return `${sym}${fxAmt} (Cotización aplicada: ${rate})${eq}`
  }
  return `${money(o.total)} ARS · (sin cotización histórica registrada)`
}

/* ---------------- Aprobación (unificada: Aprobar / A Devolver / Problemas) ---------------- */

function renderAprobacion() {
  const nPend = pending().length
  const nBack = backGroups().length
  const nInc = incidents.filter((i) => i.status !== 'cerrado').length

  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('check', 18, 2)} Aprobación y seguimiento</div>
      <div class="card card--unified">
        <div class="ap-tabs segmented">
          <button data-apt="aprobar" class="${apTab === 'aprobar' ? 'on' : ''}" type="button">${icon('check', 14, 2)} Aprobar${nPend ? ` · ${nPend}` : ''}</button>
          <button data-apt="devolver" class="${apTab === 'devolver' ? 'on' : ''}" type="button">${icon('box', 14, 2)} A devolver${nBack ? ` · ${nBack}` : ''}</button>
          <button data-apt="problemas" class="${apTab === 'problemas' ? 'on' : ''}" type="button">${icon('xmark', 14, 2)} Problemas${nInc ? ` · ${nInc}` : ''}</button>
        </div>
        <div id="ap-body"></div>
      </div>
    </div>
  `

  panelEl.querySelectorAll('[data-apt]').forEach((b) => {
    b.addEventListener('click', () => {
      apTab = b.dataset.apt
      renderAprobacion()
    })
  })

  if (apTab === 'aprobar') renderAprobarTab()
  else if (apTab === 'devolver') renderDevolverTab()
  else renderProblemasTab()
}

/* --- Solapa Aprobar --- */

function renderAprobarTab() {
  const body = panelEl.querySelector('#ap-body')
  const pd = pending().sort((a, b) => b.createdAt - a.createdAt)
  const toApprove = pd.reduce((a, o) => a + o.total, 0)

  body.innerHTML = `
    <div class="metric-grid" style="padding:4px 10px">
      <div class="metric metric--accent"><span class="metric-label">Recaudación en espera</span><span class="metric-value">${money(toApprove)}</span></div>
      <div class="metric"><span class="metric-label">Órdenes de la tablet</span><span class="metric-value">${pd.length}</span></div>
    </div>

    ${pd.length ? pd.map((o) => {
      const cur = curSel[o.id] || null
      return `
        <div class="pd-card squircle">
          <div class="page-head" style="padding:14px 18px">
            <div class="grow">
              <div class="eyebrow">${esc(o.code)}${o.clientName ? ` · cliente: <b>${esc(o.clientName)}</b>` : ''}</div>
              <div class="mutest" style="font-size:12px;margin-top:2px">${esc(o.promoterId)} · ${o.itemQty} ítem${o.itemQty !== 1 ? 's' : ''} · ${money(o.total)} · ${fmtDateTime(o.createdAt)}</div>
            </div>
            <span class="badge badge--orange">Pendiente</span>
          </div>
          <details class="pd-detail">
            <summary>${icon('list', 14, 2)} Ver detalle · ${o.itemQty} ítem${o.itemQty !== 1 ? 's' : ''}</summary>
            <div class="pd-items">
              ${o.items.map((it) => `
                <div class="row-item" style="border-radius:0;border-left:none;border-right:none">
                  <div class="row-thumb">${icon('tag', 18, 1.8)}</div>
                  <div class="row-main">
                    <div class="row-title">${esc(it.name)}</div>
                    <div class="row-sub">${money(it.price)} × ${it.qty}</div>
                  </div>
                  <span class="amount" style="font-weight:600">${money(it.line)}</span>
                </div>`).join('')}
            </div>
          </details>
          <div class="card card--padded" style="border:none;border-radius:0">
            <div class="row" style="flex-wrap:wrap;gap:14px">
              <div class="field grow" style="min-width:220px">
                <label for="ap-cur-${o.id}">Moneda de cobro · obligatoria</label>
                <div class="segmented">
                  ${CUR_OPTS.map(([k, l]) => `<button data-cur="${k}" type="button" class="${cur === k ? 'on' : ''}">${l}</button>`).join('')}
                </div>
              </div>
              <div class="field grow" style="min-width:220px">
                <label for="ap-doc-${o.id}">Documento del cliente (aval)</label>
                <input class="input" id="ap-doc-${o.id}" placeholder="DNI / Pasaporte" value="${esc(o.doc || '')}" autocomplete="off" />
              </div>
            </div>
            <div class="spread" style="margin-top:18px">
              <span class="mutest">Total · <span data-cur-label>${cur ? cur.toUpperCase() : 'elegí la divisa'}</span></span>
              <span class="big-number amount" data-cur-value>${cur ? fmtFx(cur, o.total) : '—'}</span>
            </div>
            <button class="btn btn--success btn--lg" style="width:100%;margin-top:16px" data-approve="${o.id}" ${cur ? '' : 'disabled'} type="button">
              ${icon('check', 18, 2)} ${cur ? 'Aprobar venta · generar bolsa' : 'Seleccioná la moneda para aprobar'}
            </button>
          </div>
        </div>`
    }).join('')
    : `<div class="empty">${icon('check', 38, 1.4)}<h4>Sin ventas pendientes</h4><p>Cuando la tablet de Ventas envíe una orden, aparece acá para tu visto bueno final.</p></div>`}
  `

  body.querySelectorAll('.segmented [data-cur]').forEach((b) => {
    b.addEventListener('click', () => {
      const card = b.closest('.pd-card')
      const oId = card.querySelector('[data-approve]').dataset.approve
      curSel[oId] = b.dataset.cur
      card.querySelectorAll('.segmented [data-cur]').forEach((x) => x.classList.toggle('on', x === b))
      const order = orders.find((o) => o.id === oId)
      card.querySelector('[data-cur-label]').textContent = b.dataset.cur.toUpperCase()
      card.querySelector('[data-cur-value]').textContent = fmtFx(b.dataset.cur, order.total)
      const btn = card.querySelector('[data-approve]')
      btn.disabled = false
      btn.innerHTML = `${icon('check', 18, 2)} Aprobar venta · generar bolsa`
    })
  })

  body.querySelectorAll('[data-approve]').forEach((b) => {
    b.addEventListener('click', async () => {
      const oId = b.dataset.approve
      const order = orders.find((o) => o.id === oId)
      if (!order) return
      const card = b.closest('.pd-card')
      const currency = getCurrencyForCard(card)
      if (!currency) return err('Elegí la moneda de cobro antes de aprobar')
      const doc = cleanDoc(card.querySelector(`#ap-doc-${oId}`)?.value)
      const s = getSession()
      b.disabled = true
      try {
        const res = await approveOrder(oId, { currency, doc, actor: s.username, rates: state.rates })
        ok(`Venta ${res.code} aprobada · bolsa ${res.bag}`)
        haptic([30, 40, 60])
        delete curSel[oId]
        await refresh(true)
      } catch (e) {
        err(e?.message || 'No se pudo aprobar la venta')
        b.disabled = false
      }
    })
  })
}

function getCurrencyForCard(card) {
  const oId = card.querySelector('[data-approve]')?.dataset.approve
  return curSel[oId] || null
}

/* --- Solapa A Devolver --- */

function renderDevolverTab() {
  const body = panelEl.querySelector('#ap-body')
  const groups = backGroups()

  body.innerHTML = `
    <div class="metric-grid" style="padding:4px 10px">
      <div class="metric"><span class="metric-label">Retornos reportados</span><span class="metric-value">${groups.length}</span><span class="metric-hint">listos para cierre formal</span></div>
    </div>
    ${groups.length ? groups.map((g) => {
      const order = orders.find((o) => o.code === g.orderCode)
      const qty = rentals.filter((r) => r.orderCode === g.orderCode && r.status === 'back').reduce((a, r) => a + (r.qty || 1), 0)
      const inc = openIncidents(g.orderCode)
      return `
        <div class="pd-card squircle">
          <div class="page-head" style="padding:14px 18px">
            <div class="grow">
              <div class="eyebrow">${esc(order?.clientName || g.clientName || 'Cliente')} · ${esc(g.orderCode)}</div>
              <div class="mutest" style="font-size:12px;margin-top:2px">Bolsa ${esc(g.bag || '—')} · reportado ${fmtDateTime(g.returnAt)} · ${qty} ítem${qty !== 1 ? 's' : ''}</div>
            </div>
            <span class="badge badge--green">Reportado</span>
          </div>
          ${inc.length ? `<div class="card card--padded" style="border:none;border-radius:0;background:var(--red-soft,#3a1f24)"><span style="color:#ff8f9b;font-size:13px">${icon('xmark', 14, 2)} ${inc.length} incidencia(s) abierta(s) · resolvé en “Problemas” antes de cerrar</span></div>` : ''}
          <div class="card card--padded" style="border:none;border-radius:0">
            <button class="btn btn--success btn--lg" style="width:100%" data-confirm="${g.orderCode}" ${inc.length ? 'disabled' : ''} type="button">
              ${icon('check', 18, 2)} Confirmar cierre formal
            </button>
          </div>
        </div>`
    }).join('')
    : `<div class="empty">${icon('box', 38, 1.4)}<h4>Sin retornos pendientes</h4><p>Cuando las estaciones de Ropa y Botas reporten una devolución, aparece acá para cerrar el ciclo.</p></div>`}
  `

  body.querySelectorAll('[data-confirm]').forEach((b) => {
    b.addEventListener('click', async () => {
      const s = getSession()
      b.disabled = true
      try {
        const n = await confirmReturn(b.dataset.confirm, s.username)
        ok(`Orden ${b.dataset.confirm} cerrada · ${n} ítem${n !== 1 ? 's' : ''}`)
        haptic([20, 40, 30])
        await refresh(true)
      } catch (e) {
        err(e?.message || 'No se pudo cerrar la devolución')
        b.disabled = false
      }
    })
  })
}

/* --- Solapa Problemas --- */

function openCloseIncident(inc) {
  const order = orders.find((o) => o.code === inc.orderCode)
  const { close, root } = openSheet({
    title: 'Cierre de incidencia',
    body: `
      <p class="mutest" style="font-size:12px;line-height:1.5">
        Orden <b>${esc(inc.orderCode)}</b>${order?.clientName ? ` · cliente <b>${esc(order.clientName)}</b>` : ''} ·
        <b>${INC_LABEL[inc.type] || inc.type}</b> · ${esc(inc.itemName)} · ×${inc.qty}
      </p>
      ${inc.note ? `<p class="mutest" style="font-size:12px;margin-top:6px">«${esc(inc.note)}»</p>` : ''}
      <div class="stack" style="gap:14px;margin-top:14px">
        <div class="field">
          <label>¿Fue abonado por el cliente?</label>
          <div class="segmented" id="inc-paid">
            <button data-paid="1" class="on" type="button">Sí · abonado</button>
            <button data-paid="0" type="button">No · pendiente de cobro</button>
          </div>
        </div>
        <div class="row" style="gap:12px">
          <div class="field grow">
            <label for="inc-amount">Monto exacto (ARS)</label>
            <input class="input" id="inc-amount" type="number" step="0.01" min="0" placeholder="0" autocomplete="off" />
          </div>
          <div class="field" style="min-width:150px">
            <label>Divisa</label>
            <div class="segmented" id="inc-cur">
              ${CUR_OPTS.map(([k, l]) => `<button data-cur="${k}" class="${k === 'ars' ? 'on' : ''}" type="button">${l}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="field">
          <label for="inc-note">Observación de cierre</label>
          <input class="input" id="inc-note" placeholder="Ej: abonó reposición del casco" autocomplete="off" />
        </div>
      </div>
    `,
    footer: `<button class="btn btn--danger btn--lg" id="inc-close" type="button">${icon('check', 17, 2)} Cerrar caso contablemente</button>`,
  })

  root.querySelectorAll('#inc-paid [data-paid]').forEach((b) => {
    b.addEventListener('click', () => {
      root.querySelectorAll('#inc-paid [data-paid]').forEach((x) => x.classList.toggle('on', x === b))
    })
  })
  root.querySelectorAll('#inc-cur [data-cur]').forEach((b) => {
    b.addEventListener('click', () => {
      root.querySelectorAll('#inc-cur [data-cur]').forEach((x) => x.classList.toggle('on', x === b))
    })
  })

  root.querySelector('#inc-close').addEventListener('click', async () => {
    const amount = cleanMoney(root.querySelector('#inc-amount').value)
    if (amount === null || amount <= 0) return err('Registrá el monto exacto antes de cerrar')
    const currency = root.querySelector('#inc-cur [data-cur].on')?.dataset.cur || 'ars'
    const paid = root.querySelector('#inc-paid [data-paid].on')?.dataset.paid === '1'
    const note = cleanText(root.querySelector('#inc-note').value, 200)
    const tok = await confirmCritical({ action: 'incidencia.cerrar', target: inc.orderCode, word: 'CERRAR', note: `Monto ${money(amount)} · ¿abonado? ${paid ? 'sí' : 'no'}` })
    if (!tok) return
    const s = getSession()
    try {
      await closeIncident(inc.id, { amount, currency, paid, note, actor: s.username, token: tok })
      ok(`Incidencia cerrada · ${money(amount)} en ${currency.toUpperCase()}${paid ? ' · abonado' : ' · pendiente'}`)
      haptic([20, 40, 20])
      close()
      await refresh(true)
    } catch (e) {
      err(e?.message || 'No se pudo cerrar la incidencia')
    }
  })
}

function renderProblemasTab() {
  const body = panelEl.querySelector('#ap-body')
  const list = incidents.filter((i) => i.status !== 'cerrado').sort((a, b) => b.at - a.at)

  body.innerHTML = `
    <div class="metric-grid" style="padding:4px 10px">
      <div class="metric metric--orange"><span class="metric-label">Casos abiertos</span><span class="metric-value">${list.length}</span><span class="metric-hint">roturas · pérdidas · faltantes</span></div>
    </div>
    ${list.length ? list.map((inc) => {
      const order = orders.find((o) => o.code === inc.orderCode)
      return `
        <div class="pd-card squircle">
          <div class="page-head" style="padding:14px 18px">
            <div class="grow">
              <div class="eyebrow">${esc(order?.clientName || 'Cliente')} · ${esc(inc.orderCode)}</div>
              <div class="mutest" style="font-size:12px;margin-top:2px">${fmtDateTime(inc.at)} · reportado por <b>${esc(inc.reportedBy)}</b></div>
            </div>
            <span class="badge badge--orange">${INC_LABEL[inc.type] || inc.type}</span>
          </div>
          <div class="row-item" style="border-radius:12px;margin:0 14px">
            <div class="row-thumb">${icon('box', 18, 1.8)}</div>
            <div class="row-main">
              <div class="row-title">${esc(inc.itemName)}</div>
              <div class="row-sub">×${inc.qty}${inc.note ? ` · «${esc(inc.note)}»` : ''}</div>
            </div>
          </div>
          <div class="card card--padded" style="border:none;border-radius:0">
            <button class="btn btn--primary btn--lg" style="width:100%" data-incclose="${inc.id}" type="button">${icon('doc', 17, 2)} Procesar cobro y cerrar caso</button>
          </div>
        </div>`
    }).join('')
    : `<div class="empty">${icon('check', 38, 1.4)}<h4>Sin incidencias abiertas</h4><p>Los problemas detectados en la devolución aparecen acá para su control financiero.</p></div>`}
  `

  body.querySelectorAll('[data-incclose]').forEach((b) => {
    b.addEventListener('click', () => {
      const inc = incidents.find((x) => x.id === b.dataset.incclose)
      if (inc) openCloseIncident(inc)
    })
  })
}

/* ---------------- Resumen ---------------- */

function renderResumen() {
  const tod = approvedToday()
  const revenue = tod.reduce((a, o) => a + arsEqOf(o), 0)
  const tickets = tod.length
  const avg = tickets ? Math.round(revenue / tickets) : 0
  const active = rentals.filter((r) => r.status === 'out').length
  const pend = pending().length

  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('house', 18, 2)} Resumen general</div>
      <div class="metric-grid">
        <div class="metric metric--accent">
          <span class="metric-label">Recaudación hoy</span>
          <span class="metric-value">${money(revenue)}</span>
          <span class="metric-hint">${tickets} ventas aprobadas</span>
        </div>
        <div class="metric metric--green">
          <span class="metric-label">Ticket promedio</span>
          <span class="metric-value">${money(avg)}</span>
        </div>
        <div class="metric metric--purple">
          <span class="metric-label">Préstamos activos</span>
          <span class="metric-value">${active}</span>
        </div>
        <div class="metric ${pend ? 'metric--orange' : ''}">
          <span class="metric-label">Por aprobar</span>
          <span class="metric-value">${pend}</span>
        </div>
      </div>

      <div class="card">
        <div class="page-head" style="padding:14px 18px"><div class="grow"><div class="eyebrow">Últimas ventas</div></div></div>
        ${tod.length ? tod.slice(0, 6).map((o) => `
          <div class="row-item" style="border-radius:0;border-left:none;border-right:none">
            <div class="row-thumb" style="width:38px;height:38px">${icon('ticket', 17, 2)}</div>
            <div class="row-main">
              <div class="spread">
                <span class="row-title">${esc(o.code)}</span>
                <span class="amount">${money(o.total)}</span>
              </div>
              <div class="row-sub">${o.clientName ? `${esc(o.clientName)} · ` : ''}${o.promoterId} · ${fmtTime(o.createdAt)} · ${o.itemQty} ítem${o.itemQty !== 1 ? 's' : ''}</div>
            </div>
            ${o.bag ? `<span class="badge badge--green" style="margin-right:6px">Bolsa ${esc(o.bag)}</span>` : ''}
            <span class="badge badge--green">Aprobada</span>
          </div>`).join('')
          : `<div class="empty" style="padding:32px 18px">${icon('ticket', 38, 1.4)}<h4>Sin ventas aprobadas hoy</h4></div>`}
      </div>
    </div>
  `
}

/* ---------------- Ventas ---------------- */

function renderVentas() {
  const periodFilter = orders.filter((o) => state.period === 'todo' || o.createdAt >= startOfDay())
  const q = state.q.toLowerCase()
  const list = periodFilter.filter((o) => !isAnulada(o) && (!q || o.code.toLowerCase().includes(q) || o.promoterId.toLowerCase().includes(q)))
  const revenue = list.filter(isApproved).reduce((a, o) => a + o.total, 0)

  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('list', 18, 2)} Ventas · ${money(revenue)}</div>
      <div class="row" style="flex-wrap:wrap">
        <div class="search grow">${icon('search', 18, 2)}<input class="input" id="v-q" placeholder="Buscar por código u operador…" autocomplete="off" /></div>
        <div class="segmented">
          <button data-per="hoy" class="${state.period === 'hoy' ? 'on' : ''}">Hoy</button>
          <button data-per="todo" class="${state.period === 'todo' ? 'on' : ''}">Todo</button>
        </div>
      </div>
      ${list.length ? list.map((o) => `
        <div class="sales-card squircle">
          <div class="sales-head">
            <div class="grow">
              <div class="sales-code mono">${esc(o.code)}${o.clientName ? ` · <b>${esc(o.clientName)}</b>` : ''}</div>
              <div class="mutest" style="font-size:12px;margin-top:2px">${esc(o.promoterId)} · ${fmtDateTime(o.createdAt)}</div>
            </div>
            <span class="${isApproved(o) ? 'badge badge--green' : 'badge badge--orange'}">${isApproved(o)
              ? `${o.currency ? o.currency.toUpperCase() : 'ARS'} · Aprobada${o.bag ? ` · ${esc(o.bag)}` : ''}`
              : 'Pendiente'}</span>
          </div>
          <div class="sales-body">
            <div class="sales-col"><span class="metric-label">Ítems</span><span class="sales-v">${o.itemQty}</span></div>
            <div class="sales-col"><span class="metric-label">Cobro</span><span class="sales-v">${amountOf(o)}</span></div>
          </div>
          <div class="sales-foot">
            <button class="btn btn--sm btn--accent" data-det="${o.id}" type="button">${icon('eye', 14, 1.8)} Ver detalle</button>
            <div class="grow"></div>
            ${deletable(o)
              ? `<button class="btn btn--sm btn--danger" data-dell="${o.id}" type="button">${icon('trash', 14, 2)} Eliminar</button>`
              : isApproved(o)
                ? `<button class="btn btn--sm btn--ghost" data-anul="${o.id}" type="button">${icon('doc', 14, 2)} Anular</button>`
                : ''}
          </div>
        </div>`).join('')
      : `<div class="empty">Sin ventas para el filtro elegido</div>`}
    </div>
  `

  panelEl.querySelector('#v-q').addEventListener('input', (e) => {
    state.q = e.target.value
    renderVentas()
  })
  panelEl.querySelectorAll('[data-per]').forEach((b) => {
    b.addEventListener('click', () => {
      state.period = b.dataset.per
      renderVentas()
    })
  })
  panelEl.querySelectorAll('[data-dell]').forEach((b) => {
    b.addEventListener('click', async () => {
      const o = orders.find((x) => x.id === b.dataset.dell)
      if (!o) return
      const tok = await confirmCritical({ action: 'venta.eliminar', target: o.code, word: 'ELIMINAR', note: `Venta ${o.code} · ${money(o.total)} · ${o.promoterId}` })
      if (!tok) return
      const s = getSession()
      try {
        await deleteSale(o.id, tok, s.username)
        ok(`Venta ${o.code} eliminada · registrada en auditoría`)
        haptic([20, 40, 20])
        await refresh(true)
      } catch (e) {
        err(e?.message || 'No se pudo eliminar la venta')
      }
    })
  })
  panelEl.querySelectorAll('[data-det]').forEach((b) => {
    b.addEventListener('click', () => {
      const o = orders.find((x) => x.id === b.dataset.det)
      if (!o) return
      openDetail({
        title: `Ver detalle · ${o.code}${o.clientName ? ` · ${titleCase(o.clientName)}` : ''}`,
        rows: o.items.map((it) => ({
          icon: 'tag',
          name: it.name,
          sub: `${money(it.price)} × ${it.qty}`,
          value: money(it.line),
        })),
        footer: `
          <div class="row" style="justify-content:space-between;width:100%">
            <span class="mutest" style="font-size:12px">${(o.currency || 'ARS').toUpperCase()} · ${fmtDateTime(o.createdAt)} · ${esc(o.promoterId)}</span>
            <span class="num-tabular" style="font-weight:700">${amountOf(o)}</span>
          </div>`,
      })
    })
  })
  panelEl.querySelectorAll('[data-anul]').forEach((b) => {
    b.addEventListener('click', async () => {
      const o = orders.find((x) => x.id === b.dataset.anul)
      if (!o) return
      const { close, root } = openSheet({
        title: `Nota de anulación · ${o.code}`,
        body: `
          <p class="mutest" style="font-size:12px;line-height:1.5">La venta está congelada contablemente (entregas físicas registradas). No se elimina: queda con una nota de anulación formal y se conserva en el historial.</p>
          <div class="field" style="margin-top:12px">
            <label for="anul-note">Motivo de la anulación</label>
            <input class="input" id="anul-note" placeholder="Ej: error de cobro, orden duplicada…" autocomplete="off" />
          </div>
        `,
        footer: `<button class="btn btn--primary btn--lg" id="anul-go" type="button">${icon('doc', 17, 2)} Registrar anulación</button>`,
      })
      root.querySelector('#anul-go').addEventListener('click', async () => {
        const note = cleanText(root.querySelector('#anul-note').value, 200)
        close()
        const tok = await confirmCritical({ action: 'venta.anular', target: o.code, word: 'ANULAR', note: `Venta ${o.code} · ${money(o.total)}` })
        if (!tok) return
        const s = getSession()
        const card = b.closest('.sales-card')
        animateOut(card, { scale: 0.95, duration: 260 })
        try {
          await anularSale(o.id, { note, token: tok, actor: s.username })
          ok(`Nota de anulación registrada · ${o.code}`)
          haptic([20, 40, 20])
        } catch (e) {
          err(e?.message || 'No se pudo registrar la anulación')
        }
        renderVentas()
      })
    })
  })
  const qIn = panelEl.querySelector('#v-q')
  qIn.value = state.q
  qIn.focus({ preventScroll: true })
}

/* ---------------- Inventario (CRUD) ---------------- */

function openItemForm(item = null) {
  const editing = !!item
  const { close, root } = openSheet({
    title: editing ? 'Editar artículo' : 'Nuevo artículo',
    body: `
      <div class="stack" style="gap:14px">
        <div class="field">
          <label for="in-name">Nombre</label>
          <input class="input" id="in-name" placeholder="Nombre del artículo" value="${item ? esc(item.name) : ''}" autocomplete="off" />
        </div>
        <div class="field">
          <label for="in-cat">Categoría</label>
          <select class="input" id="in-cat">
            ${CATEGORY_IDS.map((cid) => `<option value="${cid}" ${item?.category === cid ? 'selected' : ''}>${CATEGORIES[cid].label}</option>`).join('')}
          </select>
        </div>
        <div class="row" style="gap:12px">
          <div class="field grow">
            <label for="in-price">Precio por día (ARS)</label>
            <input class="input" id="in-price" type="number" step="0.01" min="0" value="${item ? item.price : ''}" />
          </div>
          <div class="field" style="width:110px">
            <label for="in-order">Orden</label>
            <input class="input" id="in-order" type="number" step="1" min="0" value="${item ? item.order || 0 : Math.max(0, ...catalog.map((p) => p.order || 0)) + 1}" />
          </div>
        </div>
      </div>
    `,
    footer: `<button class="btn btn--primary btn--lg" id="in-save" type="button">${editing ? 'Guardar cambios' : 'Crear artículo'}</button>`,
  })

  root.querySelector('#in-save').addEventListener('click', async () => {
    const name = cleanText(root.querySelector('#in-name').value, 80)
    const category = root.querySelector('#in-cat').value
    const price = cleanMoney(root.querySelector('#in-price').value)
    const order = cleanInt(root.querySelector('#in-order').value)
    if (!name) return err('El nombre es obligatorio')
    if (!CATEGORY_IDS.includes(category)) return err('Categoría inválida')
    if (price === null) return err('Ingresá un precio válido')
    const s = getSession()
    const data = { name, category, price, order }
    if (editing) {
      await CATALOG().update(item.id, data)
      await logAudit(s.username, 'item.editar', item.id, { name, category, price })
      ok(`Artículo actualizado · ${name}`)
    } else {
      await CATALOG().add({ id: uid(), ...data })
      await logAudit(s.username, 'item.crear', name, { category, price })
      ok(`Artículo creado · ${name}`)
    }
    haptic(12)
    close()
    await refresh(true)
  })
}

async function deleteItem(id) {
  const p = catalog.find((x) => x.id === id)
  if (!p) return
  const tok = await confirmCritical({ action: 'item.eliminar', target: p.name, word: 'ELIMINAR', note: `Artículo «${p.name}» · ${money(p.price)}` })
  if (!tok) return
  const s = getSession()
  try {
    await runCritical(tok, 'item.eliminar', p.name, async () => {
      await CATALOG().delete(id)
      await logAudit(s.username, 'item.eliminar', p.name, { id, category: p.category })
    })
    ok(`Artículo eliminado · ${p.name}`)
    haptic([20, 40, 20])
    await refresh(true)
  } catch (e) {
    err(e?.message || 'No se pudo eliminar el artículo')
  }
}

function renderInventario() {
  const active = rentals.filter((r) => r.status === 'out')
  const returnedToday = rentals.filter((r) => (r.status === 'back' || r.status === 'cerrado') && (r.returnAt || r.confirmedAt || 0) >= startOfDay())

  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('box', 18, 2)} Inventario · Administración</div>

      <div class="metric-grid">
        <div class="metric"><span class="metric-label">Artículos en catálogo</span><span class="metric-value">${catalog.length}</span></div>
        <div class="metric metric--purple"><span class="metric-label">Préstamos activos</span><span class="metric-value">${active.length}</span></div>
        <div class="metric metric--green"><span class="metric-label">Devueltos hoy</span><span class="metric-value">${returnedToday.length}</span></div>
      </div>

      <div class="card">
        <div class="page-head" style="padding:14px 18px">
          <div class="grow"><div class="eyebrow">Catálogo de productos</div></div>
          <button class="btn btn--sm btn--success" id="inv-new" type="button">${icon('plus', 15, 2)} Nuevo artículo</button>
        </div>
        <div class="vlist" style="padding:0 14px 14px">
          ${catalog.length ? [...catalog].sort((a, b) => (a.order || 0) - (b.order || 0)).map((p) => `
            <div class="row-item">
              <div class="row-thumb">${icon('box', 18, 1.8)}</div>
              <div class="row-main">
                <div class="row-title">${esc(p.name)}</div>
                <div class="row-sub">${categoryOf(p.category).label} · ${money(p.price)} por día</div>
              </div>
              <span class="amount">${money(p.price)}</span>
              <button class="icon-btn" data-edit="${p.id}" type="button" aria-label="Editar">${icon('doc', 17, 2)}</button>
              <button class="icon-btn" data-del="${p.id}" type="button" aria-label="Eliminar">${icon('trash', 17, 2)}</button>
            </div>`).join('') : `<div class="empty">${icon('box', 38, 1.4)}<h4>Catálogo vacío</h4></div>`}
        </div>
      </div>

      <div>
        <div class="section-title" style="margin-bottom:12px">${icon('box', 18, 2)} Equipos en pista · indumentaria</div>
        ${active.length ? active.slice(0, 20).map((r) => `
          <div class="row-item">
            <div class="row-thumb">${icon('box', 20, 1.8)}</div>
            <div class="row-main">
              <div class="row-title">${esc(r.name)}</div>
              <div class="row-sub">${r.clientName ? `Cliente: ${esc(r.clientName)} · ` : ''}${CATEGORIES[r.category]?.label || ''} · ${fmtDate(r.outAt)} ${fmtTime(r.outAt)} · ${r.operatorId}</div>
            </div>
          </div>`).join('')
          : `<div class="empty">${icon('box', 38, 1.4)}<h4>Sin equipos activos</h4></div>`}
      </div>
    </div>
  `

  panelEl.querySelector('#inv-new').addEventListener('click', () => openItemForm())
  panelEl.querySelectorAll('[data-edit]').forEach((b) => {
    b.addEventListener('click', () => openItemForm(catalog.find((x) => x.id === b.dataset.edit)))
  })
  panelEl.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', () => deleteItem(b.dataset.del))
  })
}

/* ---------------- Economía (panel administrativo) ---------------- */

const promoterByName = (username) => promoters.find((p) => p.username === username)

function promoterStats(username) {
  const oo = orders.filter((o) => o.promoterId === username && isApproved(o))
  const pct = Number(promoterByName(username)?.pct || 0)
  const rev = oo.reduce((a, o) => a + o.total, 0)
  return { oo, pases: oo.length, rev, pct, comision: (rev * pct) / 100 }
}

async function saveRates(root = panelEl) {
  const usd = parseFloat(root.querySelector('#fx-usd')?.value)
  const brl = parseFloat(root.querySelector('#fx-brl')?.value)
  if (isNaN(usd) || isNaN(brl) || usd <= 0 || brl <= 0) {
    err('Ingresá valores válidos')
    return false
  }
  state.rates = { usd, brl }
  await setMeta('rates', state.rates)
  const s = getSession()
  await logAudit(s.username, 'rates.update', 'usa/brl', { usd, brl })
  ok('Tipos de cambio actualizados para toda la red')
  return true
}

function openPromoterForm() {
  const { close, root } = openSheet({
    title: 'Nuevo promotor',
    body: `
      <div class="stack" style="gap:14px">
        <div class="field">
          <label for="pr-user">Nombre de usuario</label>
          <input class="input" id="pr-user" placeholder="usuario (letras, números, . _ -)" autocapitalize="none" spellcheck="false" autocomplete="off" />
        </div>
        <div class="field">
          <label for="pr-pass">Contraseña (mín 6 caracteres)</label>
          <input class="input" id="pr-pass" type="password" placeholder="••••••••" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="pr-pct-new">Comisión / ganancia (%)</label>
          <input class="input" id="pr-pct-new" type="number" step="0.5" min="0" max="100" value="0" />
        </div>
      </div>
    `,
    footer: `<button class="btn btn--success btn--lg" id="pr-create" type="button">${icon('plus', 18, 2)} Dar de alta</button>`,
  })

  root.querySelector('#pr-create').addEventListener('click', async () => {
    const username = slugUser(root.querySelector('#pr-user').value)
    const password = passValid(root.querySelector('#pr-pass').value)
    const pct = parseFloat(root.querySelector('#pr-pct-new').value)
    const s = getSession()
    if (!username) return err('Usuario inválido · solo minúsculas, números, guiones y puntos')
    if (!password) return err('La contraseña debe tener al menos 6 caracteres')
    if (/^pbkdf2\$/.test(password)) return err('Contraseña inválida')
    if (isNaN(pct) || pct < 0 || pct > 100) return err('Porcentaje inválido')
    if (promoterByName(username) || ROLES_FIXED.has(username)) return err(`Ya existe el usuario ${username}`)
    const stored = await hashForPromoter(password)
    await addPromoter({ id: uid(), username, password: stored, pct })
    await logAudit(s.username, 'promotor.crear', username, { pct })
    ok(`Promotor ${username} dado de alta`)
    haptic(12)
    close()
    await refresh(true)
  })
}

const ROLES_FIXED = new Set(['ventas', 'botas', 'equipo', 'ropa', 'recepcion'])

function hashForPromoter(password) {
  return import('../../auth/crypto.js').then((m) => m.hashPassword(password))
}

function openPromoterEdit(username) {
  const pr = promoterByName(username)
  if (!pr) return
  const st = promoterStats(username)
  const { close, root } = openSheet({
    title: `Promotor · ${esc(username)}`,
    body: `
      <div class="metric-grid" style="padding:4px 0">
        <div class="metric"><span class="metric-label">Recaudación</span><span class="metric-value">${money(st.rev)}</span></div>
        <div class="metric"><span class="metric-label">Ventas</span><span class="metric-value">${st.pases}</span></div>
        <div class="metric"><span class="metric-label">Comisión estimada</span><span class="metric-value">${money(st.comision)}</span></div>
      </div>
      <div class="stack" style="gap:14px;margin-top:8px">
        <div class="field">
          <label for="pr-edit-user">Nombre de usuario</label>
          <input class="input" id="pr-edit-user" value="${esc(username)}" autocapitalize="none" spellcheck="false" autocomplete="off" />
        </div>
        <div class="field">
          <label for="pr-edit-pass">Contraseña</label>
          <input class="input" id="pr-edit-pass" type="password" placeholder="Dejar en blanco para no cambiar" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="pr-edit-pct">Comisión / ganancia (%)</label>
          <input class="input" id="pr-edit-pct" type="number" step="0.5" min="0" max="100" value="${st.pct}" />
        </div>
      </div>
    `,
    footer: `
      <button class="btn btn--danger" id="pr-del" type="button">${icon('trash', 17, 2)} Eliminar</button>
      <button class="btn btn--primary grow" id="pr-save" type="button">Guardar cambios</button>
    `,
  })

  root.querySelector('#pr-save').addEventListener('click', async () => {
    const newUser = slugUser(root.querySelector('#pr-edit-user').value)
    const pct = parseFloat(root.querySelector('#pr-edit-pct').value)
    const s = getSession()
    if (!newUser) return err('Usuario inválido · solo minúsculas, números, guiones y puntos')
    if (isNaN(pct) || pct < 0 || pct > 100) return err('Porcentaje inválido')
    const rawPass = root.querySelector('#pr-edit-pass').value
    let passwordFinal = pr.password
    if (rawPass) {
      const valid = passValid(rawPass)
      if (!valid) return err('La contraseña debe tener al menos 6 caracteres')
      if (/^pbkdf2\$/.test(valid)) return err('Contraseña inválida')
      passwordFinal = await hashForPromoter(valid)
    }
    if (newUser !== username) {
      if (promoterByName(newUser)) return err(`Ya existe el usuario ${newUser}`)
      const all = await ORDERS().toArray()
      await Promise.all(all.filter((o) => o.promoterId === username).map((o) => ORDERS().update(o.id, { promoterId: newUser })))
    }
    await updatePromoter(pr.id, { username: newUser, password: passwordFinal, pct })
    await logAudit(s.username, 'promotor.editar', newUser, { pct, authChanged: !!rawPass })
    ok(`Promotor ${newUser} actualizado`)
    haptic([20, 30])
    close()
    await refresh(true)
  })

  root.querySelector('#pr-del').addEventListener('click', async () => {
    const prRow = promoterByName(username)
    if (!prRow) return
    const s = getSession()
    const tok = await confirmCritical({ action: 'promotor.eliminar', target: username, word: 'ELIMINAR', note: `Promotor ${username} · ${promoterStats(username).pases} ventas históricas conservadas` })
    if (!tok) return
    close()
    try {
      await runCritical(tok, 'promotor.eliminar', username, async () => {
        await removePromoter(prRow.id)
        await logAudit(s.username, 'promotor.eliminar', username, {})
      })
      ok(`Promotor ${username} eliminado`)
      haptic([20, 40, 20])
      await refresh(true)
    } catch (e) {
      err(e?.message || 'No se pudo eliminar al promotor')
    }
  })
}

function renderEconomia() {
  const approved = orders.filter(isApproved)
  const rec = approved.reduce((a, o) => a + arsEqOf(o), 0)
  const hoy = approvedToday().sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0))
  const recHoy = hoy.reduce((a, o) => a + arsEqOf(o), 0)
  const curTotals = (cur) => ({
    n: hoy.filter((o) => (o.currency || 'ars') === cur).length,
    cur: hoy.filter((o) => (o.currency || 'ars') === cur).reduce((a, o) => a + Number(o.fx?.cur || 0), 0),
    ars: hoy.filter((o) => (o.currency || 'ars') === cur).reduce((a, o) => a + arsEqOf(o), 0),
  })
  const usdTot = curTotals('usd')
  const brlTot = curTotals('brl')
  const arsTot = curTotals('ars')
  const curText = (t, sym) => (t.n ? sym + ' ' + Number(t.cur).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—')
  const hint = (t) => (t.n ? `≈ ${money(t.ars)} ARS` : 'sin cobros')
  const list = [...promoters].sort((a, b) => promoterStats(b.username).rev - promoterStats(a.username).rev)

  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('cards', 18, 2)} Economía · Panel administrativo
        <div class="grow"></div>
        <button class="btn btn--sm btn--ghost" id="fx-btn" type="button">${icon('cards', 14, 1.8)} Divisas</button>
      </div>

      <div class="metric-grid">
        <div class="metric metric--accent"><span class="metric-label">Recaudación acumulada</span><span class="metric-value">${money(rec)}</span></div>
        <div class="metric"><span class="metric-label">Ingresos hoy</span><span class="metric-value">${money(recHoy)}</span></div>
        <div class="metric"><span class="metric-label">Ventas aprobadas</span><span class="metric-value">${approved.length}</span></div>
        <div class="metric"><span class="metric-label">Promotores</span><span class="metric-value">${promoters.length}</span></div>
      </div>

      <div class="card fx-card">
        <div class="page-head" style="padding:14px 18px">
          <div class="grow"><div class="eyebrow">Ingresos de hoy</div></div>
          <span class="badge badge--accent">${hoy.length} venta${hoy.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="metric-grid" style="padding:0 18px 14px">
          <div class="metric"><span class="metric-label">USD cobrado</span><span class="metric-value" style="font-size:22px">${curText(usdTot, 'US$')}</span><span class="metric-hint">${hint(usdTot)}</span></div>
          <div class="metric"><span class="metric-label">BRL cobrado</span><span class="metric-value" style="font-size:22px">${curText(brlTot, 'R$')}</span><span class="metric-hint">${hint(brlTot)}</span></div>
          <div class="metric metric--accent"><span class="metric-label">ARS cobrado</span><span class="metric-value">${money(arsTot.ars)}</span><span class="metric-hint">${arsTot.n} venta${arsTot.n !== 1 ? 's' : ''}</span></div>
        </div>
        <div class="fx-wrap">
          <table class="fx-sheet">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Código</th>
                <th>Promotor</th>
                <th>Ítems</th>
                <th>Divisa</th>
                <th style="text-align:right">Total (ARS)</th>
              </tr>
            </thead>
            <tbody>
              ${hoy.length ? hoy.map((o) => `
                <tr title="${o.code}">
                  <td class="mutest num-tabular">${fmtTime(o.approvedAt || o.createdAt)}</td>
                  <td class="mono">${esc(o.code)}${o.clientName ? ` · <b>${esc(o.clientName)}</b>` : ''}</td>
                  <td class="mutest">${esc(o.promoterId)}${o.fx?.rate ? ` · tasa ${money(o.fx.rate)}` : ''}</td>
                  <td class="num-tabular">${o.itemQty}</td>
                  <td>${(o.currency || 'ARS').toUpperCase()}</td>
                  <td class="num-tabular amount" style="text-align:right">${amountOf(o)}</td>
                </tr>`).join('')
                : `<tr><td colspan="6" class="mutest" style="text-align:center;padding:22px">Sin ventas cobradas hoy.</td></tr>`}
            </tbody>
            <tfoot>
              <tr class="fx-total">
                <td colspan="5">Total contable (ARS)</td>
                <td class="num-tabular" style="text-align:right;font-weight:700">${money(recHoy)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="page-head" style="padding:14px 18px">
          <div class="grow"><div class="eyebrow">Control de promotores</div></div>
          <button class="btn btn--sm btn--success" id="pr-new" type="button">${icon('plus', 15, 2)} Nuevo promotor</button>
        </div>
        <div class="stack" style="padding:0 18px 18px">
          ${list.length ? list.map((pr) => {
            const st = promoterStats(pr.username)
            return `
            <button class="pr-row" data-pr="${pr.username}" type="button">
              <span class="mono" style="font-weight:600;min-width:96px">${esc(pr.username)}</span>
              <span class="mutest">${st.pases} ventas</span>
              <span class="badge badge--accent">${st.pct}%</span>
              <span class="pr-rev amount">${money(st.rev)}</span>
            </button>`
          }).join('')
            : `<p class="muted">Sin promotores configurados.</p>`}
        </div>
      </div>
    </div>
  `

  panelEl.querySelector('#pr-new').addEventListener('click', openPromoterForm)
  panelEl.querySelectorAll('[data-pr]').forEach((b) => {
    b.addEventListener('click', () => openPromoterEdit(b.dataset.pr))
  })
  panelEl.querySelector('#fx-btn').addEventListener('click', openRates)
}

function openRates() {
  const body = `
    <p class="mutest" style="font-size:12px;line-height:1.5;margin-bottom:12px">Valores de moneda extranjera usados en el cobro de toda la red.</p>
    <div class="stack" style="gap:14px">
      <div class="field">
        <label for="fx-usd">Dólar (1 USD = ARS)</label>
        <input class="input" id="fx-usd" type="number" step="0.01" min="0" value="${state.rates.usd}" />
      </div>
      <div class="field">
        <label for="fx-brl">Real (1 BRL = ARS)</label>
        <input class="input" id="fx-brl" type="number" step="0.01" min="0" value="${state.rates.brl}" />
      </div>
    </div>`
  const footer = `<button class="btn btn--primary btn--lg" id="fx-go" type="button">Guardar cambios</button>`
  const layer = window.matchMedia('(max-width: 640px)').matches
    ? openSheet({ title: 'Tipos de cambio', body, footer })
    : openPopover({ title: 'Tipos de cambio', body, footer })
  layer.root.querySelector('#fx-go').addEventListener('click', async () => {
    if (await saveRates(layer.root)) layer.close()
  })
}

/* ---------------- Reportes ---------------- */

function byPromoter() {
  const map = new Map()
  for (const o of orders.filter(isApproved)) {
    const cur = map.get(o.promoterId) || { count: 0, total: 0 }
    cur.count += 1
    cur.total += o.total
    map.set(o.promoterId, cur)
  }
  return [...map.entries()].sort((a, b) => b[1].total - a[1].total)
}

function barsFor(period) {
  const s0 = startOfDay()
  if (period === 'hoy') {
    const bars = []
    for (let i = 13; i >= 0; i--) {
      const to = Date.now() - i * 3600e3
      const from = to - 3600e3
      const total = orders.filter((o) => isApproved(o) && (o.approvedAt || o.createdAt) >= from && (o.approvedAt || o.createdAt) < to).reduce((a, o) => a + o.total, 0)
      bars.push({ label: fmtTime(from), total })
    }
    return bars
  }
  if (period === 'mes') {
    const bars = []
    for (let i = 29; i >= 0; i--) {
      const t = s0 - i * 864e5
      const total = orders.filter((o) => isApproved(o) && o.createdAt >= t && o.createdAt < t + 864e5).reduce((a, o) => a + o.total, 0)
      bars.push({ label: fmtDate(t).split('/').slice(0, 2).join('/'), total })
    }
    return bars
  }
  if (period === 'temp') {
    const map = {}
    for (const o of orders.filter(isApproved)) {
      const d = new Date(o.createdAt)
      const k = `${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`
      map[k] = (map[k] || 0) + o.total
    }
    return Object.entries(map).map(([label, total]) => ({ label, total }))
  }
  const bars = []
  for (let i = 6; i >= 0; i--) {
    const t = s0 - i * 864e5
    const total = orders.filter((o) => isApproved(o) && o.createdAt >= t && o.createdAt < t + 864e5).reduce((a, o) => a + o.total, 0)
    bars.push({ label: fmtDate(t).split('/').slice(0, 2).join('/'), total })
  }
  return bars
}

function topProducts() {
  const m = {}
  for (const o of orders.filter(isApproved)) {
    for (const it of o.items) m[it.name] = (m[it.name] || 0) + it.qty
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6)
}

function renderReportes() {
  const promoters = byPromoter()
  const bars = barsFor(state.rp || '7d')
  const max = Math.max(1, ...bars.map((d) => d.total))
  const top = topProducts()
  const topMax = Math.max(1, ...top.map(([, q]) => q))
  const total = orders.filter(isApproved).reduce((a, o) => a + o.total, 0)
  const approved = orders.filter(isApproved).length
  const pills = [
    ['hoy', 'Día'],
    ['7d', '7 días'],
    ['mes', 'Mes'],
    ['temp', 'Temporada'],
  ]
  const spans = {
    hoy: 'últimas 14 horas',
    '7d': 'últimos 7 días',
    mes: 'últimos 30 días',
    temp: 'toda la temporada',
  }
  const rp = state.rp || '7d'

  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('chart', 18, 2)} Reportes financieros
        <div class="grow"></div>
        <div class="segmented" style="flex-wrap:wrap">
          ${pills.map(([k, l]) => `<button data-rp="${k}" class="${rp === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>

      <div class="metric-grid">
        <div class="metric metric--accent"><span class="metric-label">Recaudación acumulada</span><span class="metric-value">${money(total)}</span></div>
        <div class="metric"><span class="metric-label">Ventas aprobadas</span><span class="metric-value">${approved}</span></div>
        <div class="metric"><span class="metric-label">Por aprobar</span><span class="metric-value">${pending().length}</span></div>
      </div>

      <div class="card card--padded report-bars">
        <div class="eyebrow">Recaudación · ${spans[rp]}</div>
        <div class="stack" style="margin-top:14px">
          ${bars.length ? bars.map((d) => `
            <div class="bar-row" title="${money(d.total)}">
              <span style="min-width:62px;font-size:12px;color:var(--text-2);white-space:nowrap">${d.label}</span>
              <div class="bar-track"><div class="bar" style="width:${Math.round((d.total / max) * 100)}%"></div></div>
              <span class="amount num-tabular" style="min-width:84px;text-align:right;font-size:12px">${money(d.total)}</span>
            </div>`).join('')
            : '<p class="muted">Sin datos para el rango.</p>'}
        </div>
      </div>

      <div class="card card--padded">
        <div class="eyebrow">Eficiencia por promotor</div>
        <div class="stack" style="margin-top:12px">
          ${promoters.length ? promoters.map(([token, d]) => `
            <div class="row">
              <span class="mono" style="font-weight:600;min-width:64px">${token}</span>
              <div class="bar-track"><div class="bar" style="width:${Math.min(100, Math.round((d.total / Math.max(1, promoters[0][1].total)) * 100))}%"></div></div>
              <span class="amount num-tabular" style="min-width:96px;text-align:right">${money(d.total)}</span>
              <span class="mutest" style="min-width:40px;text-align:right">${d.count}</span>
            </div>`).join('')
            : `<p class="muted">Sin ventas registradas.</p>`}
        </div>
      </div>

      <div class="card card--padded">
        <div class="eyebrow">Top productos</div>
        <div class="stack" style="margin-top:12px">
          ${top.length ? top.map(([name, qty], i) => `
            <div class="tp-row">
              <div class="row">
                <span class="rank-badge ${i === 0 ? 'rank-badge--1' : i === 1 ? 'rank-badge--2' : i === 2 ? 'rank-badge--3' : ''}">${i + 1}º</span>
                <span class="grow">${esc(name)}</span>
                <span class="amount num-tabular">${qty} u.</span>
              </div>
              <div class="tp-bar"><i style="width:${Math.round((qty / topMax) * 100)}%"></i></div>
            </div>`).join('')
            : '<p class="muted">Sin movimientos.</p>'}
        </div>
      </div>
    </div>
  `

  panelEl.querySelectorAll('[data-rp]').forEach((b) => {
    b.addEventListener('click', () => {
      state.rp = b.dataset.rp
      renderReportes()
    })
  })
}

/* ---------------- Auditoría ---------------- */

let auditVerify = null

const prim = (v) => {
  try {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  } catch {
    return ''
  }
}

const detailTip = (r) => {
  const base = prim(r.target)
  if (!r.detail || (typeof r.detail === 'object' && Object.keys(r.detail).length === 0)) return base
  try {
    return `${base} · ${JSON.stringify(r.detail)}`
  } catch {
    return base
  }
}

async function renderAuditoria() {
  const targetPanel = panelEl
  const targetSec = section
  const rows = await AUDIT().orderBy('at').reverse().limit(200).toArray()
  if (auditVerify === null || auditVerify.rows !== rows.length) {
    auditVerify = await verifyAudit()
  }
  if (panelEl !== targetPanel || section !== targetSec) return
  const { broken, intact } = auditVerify
  const plainRows = rows.map((r) => ({
    ts: Number(r.at) || 0,
    user: prim(r.actor),
    action: prim(r.action),
    targetId: prim(r.target),
    tip: detailTip(r),
    hash: String(r.hash || ''),
    broken: broken.includes(r.id),
  }))
  panelEl.innerHTML = `
    <div class="recep-dash pop-in">
      <div class="section-title">${icon('clock', 18, 2)} Auditoría</div>

      <div class="metric-grid">
        <div class="metric ${broken.length ? 'metric--orange' : 'metric--green'}">
          <span class="metric-label">Integridad de la cadena</span>
          <span class="metric-value" style="font-size:20px">${broken.length ? '⚠' : 'OK'}</span>
          <span class="metric-hint">${intact ? '' : `${broken.length} rotura(s) detectada(s)`}</span>
        </div>
      </div>

      <div class="card aud-card" style="margin-bottom:14px">
        <div class="page-head" style="padding:12px 18px">
          <div class="grow"><div class="eyebrow">Cada registro se enlaza con el hash del anterior (cadena global)</div></div>
          <button class="btn btn--sm" id="au-verify" type="button">${icon('doc', 15, 2)} Re-verificar</button>
        </div>
        <div class="aud-wrap">
          ${plainRows.length ? `
            <table class="aud-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Usuario</th>
                  <th>Acción</th>
                  <th>Recurso</th>
                  <th>Hash (SHA-256)</th>
                </tr>
              </thead>
              <tbody>
                ${plainRows.map((p) => `
                  <tr class="${p.broken ? 'aud-broken' : ''}">
                    <td class="mono">${fmtDate(p.ts)} ${fmtTime(p.ts)}</td>
                    <td class="mono">${esc(p.user)}</td>
                    <td>${esc(p.action)}</td>
                    <td class="mono" title="${esc(p.tip)}">${esc(p.targetId)}${p.tip !== p.targetId ? ' ⓘ' : ''}</td>
                    <td class="mono aud-hash" title="${esc(p.hash)}">${esc(String(p.hash).slice(0, 14))}…</td>
                  </tr>`).join('')}
              </tbody>
            </table>`
            : '<div class="empty" style="padding:22px">Sin eventos registrados aún.</div>'}
        </div>
      </div>
    </div>
  `
  panelEl.querySelector('#au-verify').addEventListener('click', async () => {
    auditVerify = await verifyAudit()
    const b = (await auditVerify).broken.length
    ok(b ? `Auditoría dañada · ${b} registro(s) roto(s)` : 'Auditoría verificada · cadena intacta')
    renderAuditoria()
  })
}

/* ---------------- Shell ---------------- */

const renderers = {
  resumen: renderResumen,
  aprobacion: renderAprobacion,
  ventas: renderVentas,
  inventario: renderInventario,
  economia: renderEconomia,
  reportes: renderReportes,
  auditoria: renderAuditoria,
}

function renderSidebar() {
  rootEl.querySelectorAll('.sidebar-link[data-sec]').forEach((l) => {
    l.classList.toggle('on', l.dataset.sec === section)
  })
}

let dockSig = ''
function renderRecepDock() {
  const host = rootEl?.querySelector('#dock-recep')
  if (!host) return
  const sig = `${section}|${pending().length}`
  if (sig === dockSig) return
  dockSig = sig
  mountDock(host, {
    items: SECTIONS,
    active: section,
    onSelect: (id) => {
      section = id
      haptic(8)
      paint()
    },
    count: (id) => (id === 'aprobacion' ? pending().length : 0),
  })
}

const paint = async () => {
  await load()
  renderSidebar()
  renderRecepDock()
  const meta = SECTIONS.find((sx) => sx.id === section)
  rootEl.querySelector('#panel-title').textContent = meta.label
  renderers[section]()
}

async function refresh(force = false) {
  await load()
  if (force || section === 'aprobacion' || section === 'resumen') paint()
}

function onVentasNew(e) {
  ok(`Nueva orden ${e.detail?.code || ''} enviada desde la tablet de Ventas`)
  refresh()
}

async function checkPending() {
  const count = pending().length
  if (count === lastPending) return
  if (lastPending > -1 && count > lastPending) {
    ok(`Llegó una nueva venta · ${count} para aprobar`)
  }
  lastPending = count
  if (section === 'aprobacion' || section === 'resumen' || section === 'ventas' || section === 'economia' || section === 'reportes') paint()
}

export function recepcionView() {
  let promoOff = null
  const mount = async (root) => {
    rootEl = root
    const s = getSession()
    await load()

    root.innerHTML = `
      <div class="screen screen--dash">
        <aside class="sidebar">
          <div class="sidebar-brand">
            <img class="logo" src="/favicon.svg" alt="" />
            <div class="grow">
              <h1>Aurelio SKI</h1>
              <p>Recepción · Centro de mando</p>
            </div>
          </div>
          <nav class="sidebar-nav" id="sb-nav">
            ${SECTIONS.map((sx) => `
              <button class="sidebar-link" data-sec="${sx.id}">
                ${icon(sx.icon, 18, 2)} ${sx.label}
              </button>`).join('')}
          </nav>
          <div class="sidebar-footer">
            <div class="who">
              <div style="font-weight:600">${s.role.short}</div>
              <div class="mutest mono">${s.username}</div>
            </div>
            <div class="row">
              <button class="btn btn--sm btn--ghost" id="logout" type="button">Cerrar Sesión</button>
              <button class="btn btn--sm btn--danger" id="archive" type="button">Cerrar temporada</button>
              <button class="btn btn--sm btn--danger" id="reset" type="button">Reiniciar todos los datos</button>
            </div>
          </div>
        </aside>

        <main class="panel">
          <div class="page-head">
            <div class="grow">
              <div class="eyebrow">${fmtDate(Date.now())}</div>
              <h2 id="panel-title"></h2>
            </div>
          </div>
          <div class="body-pad" id="panel"></div>
        </main>

        <div class="dock-wrap recep-dock">
          <nav class="dock" id="dock-recep" aria-label="Secciones"></nav>
        </div>
      </div>
    `

    panelEl = root.querySelector('#panel')

    root.querySelector('#logout').addEventListener('click', async () => {
      haptic(10)
      await logout()
      navigate('login', true)
    })

    root.querySelector('#reset').addEventListener('click', async () => {
      haptic(10)
      const tok = await confirmCritical({
        action: 'sistema.reset',
        target: 'toda la base',
        word: 'RESETEAR',
        note: 'Se eliminan TODOS los datos (ventas, entregas, caja, promotores, incidencias y auditoría) y se vuelve a la base de fábrica con el catálogo sembrado.',
      })
      if (!tok) return
      await resetAll()
      ok('Base reiniciada · datos de fábrica')
      navigate('login', true)
    })

    root.querySelector('#archive').addEventListener('click', async () => {
      haptic(10)
      const count = orders.length + rentals.length + incidents.length
      const tok = await confirmCritical({
        action: 'temporada.cerrar',
        target: 'temporada actual',
        word: 'CERRAR',
        note: `Se archiva TODO en /historico (${count} registros · ventas, entregas, incidencias, bolsas y links). La temporada arranca desde cero y la bolsa vuelve a 1. No se puede deshacer.`,
      })
      if (!tok) return
      try {
        const res = await archiveSeason({ actor: getSession()?.username })
        ok(`Temporada archivada en ${res.month}/${res.year}`)
        await load()
        section = 'resumen'
        paint()
      } catch (e) {
        if (e?.code === 'ARCHIVADO') {
          err('Ese mes ya está archivado · viene del Historial')
        } else {
          err(e?.message || 'No se pudo cerrar la temporada')
        }
      }
    })

    root.querySelectorAll('.sidebar-link[data-sec]').forEach((b) => {
      b.addEventListener('click', () => {
        section = b.dataset.sec
        haptic(8)
        paint()
      })
    })

    document.addEventListener('ventas:new', onVentasNew)
    lastPending = pending().length
    ticker = setInterval(checkPending, 4000)
    syncOff?.()
    syncOff = subscribeData(() => {
      if (rootEl && !isEditableFocused()) refresh(true)
    })
    promoOff?.()
    promoOff = subscribePromoters(() => {
      if (rootEl) refresh(true)
    })

    section = 'aprobacion'
    apTab = 'aprobar'
    paint()
  }

  const unmount = () => {
    clearInterval(ticker)
    ticker = null
    syncOff?.()
    syncOff = null
    promoOff?.()
    promoOff = null
    document.removeEventListener('ventas:new', onVentasNew)
    rootEl = null
    panelEl = null
  }

  return { mount, unmount }
}