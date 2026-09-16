import { CATALOG, ORDERS, RENTALS, subscribeData } from '../../db/index.js'
import { categoryOf } from '../../db/categories.js'
import { getSession, logout } from '../../auth/index.js'
import { navigate } from '../../router.js'
import { icon } from '../../ui/icons.js'
import { money, esc, uid, ok, err, openSheet, fmtTime, fmtDate, emptyState, haptic } from '../../ui/components.js'
import { cleanText } from '../../ui/sanitize.js'
import { deliverRows, reportReturn, createIncident } from '../../db/ops.js'
import './rental.css'

let rootEl = null
let bodyEl = null
let listEl = null
let profile = 'equipo'
let state = { tab: 'activos' }
let catalog = []
let catalogById = new Map()
let orders = []
let rentals = []
let dataOff = null
let delivering = false

const ANIM_MS = 3000

const session = () => getSession()

const isEditableFocused = () => {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable
}

const groupItems = (o) => (o.items || []).filter((it) => itemGroup(it) === profile)

const itemGroup = (it) => {
  if (it.category) return categoryOf(it.category).group
  const prod = catalogById.get(it.productId)
  return prod ? categoryOf(prod.category).group : null
}

const groupQty = (items) => items.reduce((a, it) => a + (it.qty || 0), 0)

const groupRentalRows = (r) =>
  rentals.filter((x) => x.status === 'out' && x.orderCode === r.orderCode && groupRental(x))

const groupRental = (r) => categoryOf(r.category).group === profile

const groupDelivered = (o) => rentals.some((x) => x.orderCode === o.code && groupRental(x))

/* Una orden aparece en una estación solo si TODAS las estaciones del pedido
   ya completaron su entrega (todos los grupos tienen rentals activos). */
const orderComplete = (orderCode) => {
  const o = orders.find((x) => x.code === orderCode)
  if (!o || !o.items?.length) return false
  const groups = new Set(o.items.map((it) => itemGroup(it)).filter(Boolean))
  if (!groups.size) return false
  for (const g of groups) {
    if (!rentals.some((r) => r.orderCode === orderCode && categoryOf(r.category).group === g)) return false
  }
  return true
}

const bagLabel = (b) =>
  typeof b === 'number' || /^\d+$/.test(String(b)) ? `Nº ${b}` : String(b || '—')

const activeOrders = () =>
  orders
    .filter((o) => o.state === 'aprobada' && groupItems(o).length > 0 && !groupDelivered(o))
    .sort((a, b) => (b.approvedAt || b.createdAt || 0) - (a.approvedAt || a.createdAt || 0))

const returnRows = () => rentals.filter((r) => r.status === 'out' && groupRental(r) && orderComplete(r.orderCode))

const returnGroups = () => {
  const seen = new Map()
  for (const r of returnRows()) {
    if (!seen.has(r.orderCode)) seen.set(r.orderCode, r)
  }
  return [...seen.values()].sort((a, b) => (b.outAt || 0) - (a.outAt || 0))
}

async function refresh() {
  catalog = await CATALOG().toArray()
  catalogById = new Map(catalog.map((p) => [p.id, p]))
  orders = await ORDERS().toArray()
  rentals = await RENTALS().toArray()
}

/* ---------- Activos ---------- */

function renderActivos() {
  const list = activeOrders()
  if (!list.length) {
    listEl.innerHTML = emptyState('ticket', 'Sin pedidos pendientes', 'Las órdenes aprobadas por Recepción aparecen acá para armar y entregar la bolsa.')
    return
  }
  listEl.innerHTML = `
    <div class="rt-list">
      ${list.map((o) => {
        const items = groupItems(o)
        const qty = groupQty(items)
        return `
        <button class="rt-card" data-order="${o.id}" type="button">
          <div class="rt-card-main">
            <div class="rt-card-name">${esc(o.clientName || 'Cliente')}</div>
            <div class="rt-card-sub">Bolsa ${bagLabel(o.bag)} · aprobada ${fmtTime(o.approvedAt || o.createdAt)}</div>
          </div>
          <div class="rt-count">${qty}</div>
        </button>`
      }).join('')}
    </div>
  `
  listEl.querySelectorAll('[data-order]').forEach((b) => {
    b.addEventListener('click', () => openTicket(list.find((o) => o.id === b.dataset.order)))
  })
}

function openTicket(o) {
  const items = groupItems(o)
  const { close, root } = openSheet({
    title: 'Entrega · bolsa',
    body: `
      <div class="rt-ticket-head">
        <div class="rt-avatar">${icon('box', 20, 2)}</div>
        <div class="grow">
          <div class="rt-card-name">${esc(o.clientName || 'Cliente')}</div>
          <div class="rt-bag-label">Bolsa ${bagLabel(o.bag)}</div>
        </div>
      </div>
      <div class="rt-items">
        ${items.map((it) => `
          <div class="row-item" style="border-radius:14px">
            <div class="row-thumb">${icon('box', 18, 1.8)}</div>
            <div class="row-main">
              <div class="row-title">${esc(it.name)}</div>
              <div class="row-sub">${money(it.price)} × ${it.qty}</div>
            </div>
            <span class="amount" style="font-weight:600">× ${it.qty}</span>
          </div>`).join('')}
      </div>
      <div class="mutest" style="text-align:center;font-size:12px;margin-top:10px">
        ${groupQty(items)} elemento${groupQty(items) !== 1 ? 's' : ''} · bolsa unificada para este cliente
      </div>
    `,
    footer: `<button class="btn btn--success btn--lg" id="do-deliver" type="button">${icon('box', 18, 2)} Entregar</button>`,
  })

  root.querySelector('#do-deliver').addEventListener('click', async () => {
    if (delivering) return
    delivering = true
    const s = session()
    const rows = groupItems(o).map((it) => ({
      id: uid(),
      orderCode: o.code,
      productId: it.productId,
      name: it.name,
      category: it.category || null,
      qty: it.qty || 1,
      line: it.line || 0,
      clientName: o.clientName || null,
      bag: o.bag || null,
      status: 'out',
      sessionId: s.sessionId,
      operatorId: s.username,
      outAt: Date.now(),
      returnAt: null,
    }))
    try {
      await deliverRows(rows, s.username)
    } catch (e) {
      err(e?.message || 'No se pudo registrar la entrega')
      haptic([30, 60, 30])
      delivering = false
      close()
      await refresh()
      paint()
      return
    }
    await playDeliverAnim(o)
    close()
    delivering = false
    ok(`Bolsa ${bagLabel(o.bag)} entregada · todo listo`)
    haptic([30, 50, 40])
    await refresh()
    paint()
  })
}

function playDeliverAnim(o) {
  return new Promise((resolve) => {
    const host = document.querySelector('#app') || document.body
    const el = document.createElement('div')
    el.className = 'rt-anim'
    el.innerHTML = `
      <div class="rt-anim-inner">
        <div class="rt-anim-check">${icon('check', 34, 2.6)}</div>
        <div class="rt-anim-title">Todo entregado correctamente</div>
        <div class="rt-anim-sub">Bolsa ${bagLabel(o.bag)} · armada y lista</div>
        <div class="rt-anim-bar"><span></span></div>
      </div>
    `
    host.appendChild(el)
    setTimeout(() => {
      el.classList.add('done')
      setTimeout(() => el.remove(), 300)
      resolve()
    }, ANIM_MS)
  })
}

/* ---------- A Devolver ---------- */

function renderReturns() {
  const groups = returnGroups()
  if (!groups.length) {
    listEl.innerHTML = emptyState('box', 'Sin devoluciones pendientes', 'Las entregas aparecen acá una vez que todas las estaciones completaron el armado de la bolsa y quedó lista la devolución.')
    return
  }
  listEl.innerHTML = `
    <div class="rt-list">
      ${groups.map((g) => {
        const rows = groupRentalRows(g)
        const qty = rows.reduce((a, r) => a + (r.qty || 1), 0)
        return `
        <button class="rt-card" data-return="${g.orderCode}" type="button">
          <div class="rt-card-main">
            <div class="rt-card-name">${esc(g.clientName || 'Cliente')}</div>
            <div class="rt-card-sub">Bolsa ${bagLabel(g.bag)} · entregada ${fmtDate(g.outAt)} ${fmtTime(g.outAt)}</div>
          </div>
          <div class="rt-count rt-count--alert">${qty}</div>
        </button>`
      }).join('')}
    </div>
  `
  listEl.querySelectorAll('[data-return]').forEach((b) => {
    b.addEventListener('click', () => openReturn(b.dataset.return))
  })
}

function openReturn(orderCode) {
  const rows = rentals
    .filter((r) => r.status === 'out' && r.orderCode === orderCode && groupRental(r))
    .sort((a, b) => (a.outAt || 0) - (b.outAt || 0))
  const firstName = rows[0]?.clientName
  const bag = rows[0]?.bag
  const qty = rows.reduce((a, r) => a + (r.qty || 1), 0)
  const { close, root } = openSheet({
    title: 'Devolución',
    body: `
      <div class="rt-ticket-head">
        <div class="rt-avatar rt-avatar--alert">${icon('check', 20, 2)}</div>
        <div class="grow">
          <div class="rt-card-name">${firstName ? esc(firstName) : 'Cliente'}</div>
          <div class="rt-bag-label rt-bag--alert">Bolsa ${bagLabel(bag)}</div>
        </div>
      </div>
      <div class="mutest" style="font-size:12px;margin:2px 0 10px">Artículos que trajo de vuelta · revisión rápida</div>
      <div class="rt-items">
        ${rows.map((r) => `
          <div class="row-item" style="border-radius:14px">
            <div class="row-thumb">${icon('check', 18, 2)}</div>
            <div class="row-main">
              <div class="row-title">${esc(r.name)}</div>
              <div class="row-sub rt-qty-alert">Cantidad ${r.qty || 1}</div>
            </div>
            <span class="amount rt-qty-alert" style="font-weight:600">× ${r.qty || 1}</span>
          </div>`).join('')}
      </div>

      <div class="ap-inc" style="margin-top:14px">
        <label class="row" style="gap:10px;cursor:pointer">
          <input type="checkbox" id="rt-inc" />
          <span style="font-weight:600;font-size:14px">Reportar incidencia</span>
          <span class="mutest" style="font-size:12px">rotura · pérdida · faltante</span>
        </label>
        <div id="rt-inc-box" hidden style="margin-top:12px;display:flex;flex-direction:column;gap:12px">
          <div class="segmented" id="rt-inc-type">
            <button data-intype="rotura" class="on" type="button">Rotura</button>
            <button data-intype="perdida" type="button">Pérdida</button>
            <button data-intype="faltante" type="button">Faltante</button>
          </div>
          <div class="field">
            <label for="rt-inc-item">Artículo comprometido</label>
            <select class="input" id="rt-inc-item">
              ${rows.map((r) => `<option value="${r.id}">${esc(r.name)} · ×${r.qty || 1}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="rt-inc-note">Detalle visible / observación</label>
            <input class="input" id="rt-inc-note" placeholder="Ej: capa exterior rasgada…" autocomplete="off" />
          </div>
        </div>
      </div>
    `,
    footer: `
      <div class="mutest" style="font-size:12px;text-align:center;margin-bottom:8px">
        El retorno queda reportado para que Recepción confirme el cierre formal del ciclo.
      </div>
      <button class="btn btn--success btn--lg" id="do-return" type="button">${icon('check', 18, 2)} Confirmar retorno (todo)</button>
    `,
  })

  const incCheck = root.querySelector('#rt-inc')
  const incBox = root.querySelector('#rt-inc-box')
  incCheck.addEventListener('change', () => {
    incBox.hidden = !incCheck.checked
  })
  root.querySelectorAll('#rt-inc-type [data-intype]').forEach((b) => {
    b.addEventListener('click', () => {
      root.querySelectorAll('#rt-inc-type [data-intype]').forEach((x) => x.classList.toggle('on', x === b))
    })
  })

  let returning = false
  root.querySelector('#do-return').addEventListener('click', async () => {
    if (returning) return
    returning = true
    const s = session()
    try {
      if (incCheck.checked) {
        const type = root.querySelector('#rt-inc-type [data-intype].on')?.dataset.intype || 'rotura'
        const itemRow = rows.find((r) => r.id === root.querySelector('#rt-inc-item').value) || rows[0]
        const note = cleanText(root.querySelector('#rt-inc-note').value, 200)
        await createIncident({
          orderCode,
          type,
          itemName: itemRow?.name || '',
          qty: 1,
          note,
          reportedBy: s.username,
        })
      }
      await reportReturn(rows.map((r) => r.id), s.username)
    } catch (e) {
      err(e?.message || 'No se pudo registrar el retorno')
      haptic([30, 60, 30])
      returning = false
      return
    }
    close()
    ok(`Retorno reportado · ${orderCode} · va a Recepción para confirmar el cierre`)
    haptic([20, 40])
    await refresh()
    paint()
  })
}

/* ---------- Pintado general ---------- */

function paint() {
  const activos = activeOrders().length
  const devolver = returnGroups().length

  bodyEl.innerHTML = `
    <div class="segmented rt-seg" id="rt-seg">
      <button data-t="activos" class="${state.tab === 'activos' ? 'on' : ''}">${icon('ticket', 14, 2)} Activos (${activos})</button>
      <button data-t="devolver" class="${state.tab === 'devolver' ? 'on' : ''} ${devolver ? 'rt-danger' : ''}">${icon('box', 14, 2)} A devolver${devolver ? ` <span class="rt-count-pill rt-count-pill--alert">${devolver}</span>` : ''}</button>
    </div>
    <div id="rt-body" class="rt-body"></div>
  `

  listEl = bodyEl.querySelector('#rt-body')
  bodyEl.querySelectorAll('[data-t]').forEach((b) => {
    b.addEventListener('click', () => {
      state.tab = b.dataset.t
      paint()
    })
  })

  if (state.tab === 'activos') {
    renderActivos()
  } else {
    renderReturns()
  }
}

export function rentalView(profileName) {
  const mount = async (root) => {
    rootEl = root
    profile = profileName || 'equipo'
    state.tab = 'activos'
    const s = getSession()
    await refresh()
    root.innerHTML = `
      <div class="rental screen">
        <header class="topbar">
          <div class="row" style="gap:10px">
            <div class="row-thumb" style="width:34px;height:34px;border-radius:10px">${icon('box', 17, 2)}</div>
            <div class="grow">
              <div class="row-title" style="font-size:15px">${s.role.short} · ${s.username}</div>
              <div class="row-sub">Turno desde ${fmtTime(s.loginAt)}</div>
            </div>
          </div>
          <button class="icon-btn" id="logout" title="Cerrar sesión" aria-label="Cerrar sesión">${icon('arrowleft', 18, 2)}</button>
        </header>
        <main class="content body-pad">
          <div class="stack">
<div class="page-head">
              <div class="grow">
                ${profile === 'equipo'
                  ? '<h2>Equipo · Rental</h2><p class="subtitle">Esquíes, tablas y bastones · entrega y devolución</p>'
                  : profile === 'botas'
                    ? '<h2>Botas · Rental</h2><p class="subtitle">Botas de esquí y snow · entrega y devolución</p>'
                    : '<h2>Ropa · Rental</h2><p class="subtitle">Botas de nieve e indumentaria · entrega y devolución</p>'}
              </div>
            </div>
            </div>
            <div id="rt-body"></div>
          </div>
        </main>
      </div>
    `
    bodyEl = root.querySelector('#rt-body')
    root.querySelector('#logout').addEventListener('click', async () => {
      haptic(10)
      stopDataSync()
      await logout()
      navigate('login', true)
    })
    paint()
    dataOff?.()
    dataOff = subscribeData(async () => {
      /* Los datos en tiempo real fluyen y re-renderizan #rt-body siempre,
         sin importar si hay modales abiertas (viven en #app, no se tocan).
         Solo se omite el paint si el foco está en un campo editable. */
      if (!rootEl || isEditableFocused()) return
      await refresh()
      paint()
    })
  }

  const unmount = () => {
    stopDataSync()
    rootEl = null
    bodyEl = null
  }

  return { mount, unmount }
}

function stopDataSync() {
  dataOff?.()
  dataOff = null
}