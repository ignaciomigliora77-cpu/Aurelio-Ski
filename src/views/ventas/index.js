import { CATALOG, LINKS, ORDERS, subscribeData } from '../../db/index.js'
import { findByUsername } from '../../promoters/firebase-promoters.js'
import { categoryOf } from '../../db/categories.js'
import { getSession, logout } from '../../auth/index.js'
import { navigate } from '../../router.js'
import { icon } from '../../ui/icons.js'
import { money, esc, fmtDateTime, ok, err, haptic, uid } from '../../ui/components.js'
import { cleanText } from '../../ui/sanitize.js'
import { initQrCanvas } from '../../ui/qr.js'
import './ventas.css'

const LINK_TTL = 120000

const getDesk = () => {
  let d = localStorage.getItem('aurelio.desk')
  if (!d) {
    d = 'V' + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/0/g, 'K')
    localStorage.setItem('aurelio.desk', d)
  }
  return d.toUpperCase()
}

const genCode = (prefix) =>
  prefix + '-' + Math.random().toString(36).slice(2, 8).toUpperCase().replace(/0/g, 'K')

let rootEl = null
let mainEl = null
let dataOff = null
let catalog = []
let state = { mode: 'link', q: '', promoter: null, link: null, items: {}, client: '', lastOrder: null }

async function load() {
  catalog = await CATALOG().toArray()
}

function resolveLink() {
  const link = LINKS().orderBy('at').reverse().toArray().find((l) => l.desk === getDesk())
  if (!link) return null
  if (Date.now() - link.at > LINK_TTL) return null
  if (link.expiresAt && Date.now() > link.expiresAt) return null
  return link
}

async function purgeLinks() {
  await LINKS().filter((l) => !l.expiresAt || l.expiresAt < Date.now()).delete()
}

async function handleOrdered() {
  const s = getSession()
  const clientName = cleanText(state.client, 60)
  const items = Object.entries(state.items)
    .filter(([, qty]) => qty > 0)
    .map(([pid, qty]) => {
      const prod = catalog.find((c) => c.id === pid)
      return { productId: prod.id, name: prod.name, category: prod.category, qty, price: prod.price, line: prod.price * qty }
    })
  if (!items.length || !state.promoter || !clientName) return
  if (state.link?.id) {
    const live = await LINKS().get(state.link.id)
    if (!live || Date.now() - live.at > LINK_TTL || (live.expiresAt && Date.now() > live.expiresAt)) {
      err('Tu vínculo con el promotor expiró · volvé a escanear el QR')
      state.link = null
      state.promoter = null
      state.items = {}
      state.client = ''
      goLink(true)
      return
    }
  }

  const order = {
    id: uid(),
    code: genCode('VT'),
    sessionId: s.sessionId,
    desk: getDesk(),
    promoterId: state.promoter,
    clientName,
    items,
    itemQty: items.reduce((a, i) => a + i.qty, 0),
    total: items.reduce((a, i) => a + i.line, 0),
    source: 'ventas',
    state: 'pendiente',
    currency: null,
    doc: '',
    bag: null,
    cashier: null,
    createdAt: Date.now(),
    validatedAt: null,
    approvedAt: null,
  }
  await ORDERS().add(order)
  if (state.link?.id) await LINKS().delete(state.link.id)
  document.dispatchEvent(new CustomEvent('ventas:new', { detail: { code: order.code } }))
  state.lastOrder = order.code
  state.promoter = null
  state.link = null
  state.items = {}
  state.client = ''
  haptic([30, 60, 40])
  ok(`Orden ${order.code} enviada a Recepción`)
  goLink()
}

function renderLink() {
  mainEl.innerHTML = `
    <div class="v-link pop-in">
      <div class="v-qr-card">
        <span class="v-eyebrow">Tablet de ventas · puesto ${getDesk()}</span>
        <h2>Vinculá tu sesión</h2>
        <p class="mutest">Abrí la solapa <b>Escáner</b> de tu celular y apuntá cámara a este código para vincular al promotor.</p>
        <canvas id="v-qr" width="240" height="240"></canvas>
        <div class="v-desk mono">VENTAS::${getDesk()}</div>
        <div id="v-state" class="mutest">Esperando que un promotor escanee el código…</div>
      </div>
      <div class="v-manual">
        <div class="row" style="width:100%;align-items:stretch">
          <div class="search grow">
            ${icon('search', 18, 2)}
            <input class="input" id="v-manual" placeholder="Ingresar código manual" autocomplete="off" spellcheck="false" autocapitalize="none" />
          </div>
          <button class="btn btn--primary" id="v-validar" type="button" disabled>Validar</button>
        </div>
        <p class="mutest" style="font-size:12px;text-align:center;margin-top:6px">Si la cámara no puede leer el código, ingresalo manualmente.</p>
      </div>
      ${state.lastOrder ? `
        <div class="v-sent">
          ${icon('check', 18, 2.2)}
          <div>
            <div class="v-sent-title">Orden ${esc(state.lastOrder)} enviada</div>
            <div class="mutest" style="font-size:12px">Recepción la está validando · el promotor quedó liberado.</div>
          </div>
        </div>` : ''}
      <div class="v-sent-strip" id="v-sent"></div>
    </div>
  `
  initQrCanvas(mainEl.querySelector('#v-qr'), `VENTAS::${getDesk()}`, 240)

  const manualInput = mainEl.querySelector('#v-manual')
  const validarBtn = mainEl.querySelector('#v-validar')
  const doManual = async () => {
    if (!manualInput.value.trim()) return
    await manualLink(manualInput.value)
    manualInput.select()
  }
  validarBtn.addEventListener('click', doManual)
  manualInput.addEventListener('input', () => {
    validarBtn.disabled = !manualInput.value.trim()
  })
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doManual()
  })

  renderSent()
}

async function renderSent() {
  const host = mainEl?.querySelector('#v-sent')
  if (!host || state.mode !== 'link') return
  const mine = await ORDERS().filter((o) => o.desk === getDesk() && o.state === 'pendiente').toArray()
  mine.sort((a, b) => b.createdAt - a.createdAt)
  if (!mine.length) {
    host.innerHTML = ''
    host.style.display = 'none'
    return
  }
  host.style.display = ''
  host.innerHTML = mine.map((o) => `
      <div class="pd-card squircle v-sent-card">
        <div class="spread" style="padding:12px 16px 6px">
          <span class="row-title mono">${esc(o.code)}</span>
          <span class="badge badge--orange">Pendiente</span>
        </div>
        <div class="mutest" style="padding:0 16px 12px;font-size:12px">
          <b>${esc(o.clientName || 'Cliente')}</b> · ${o.itemQty} ítem${o.itemQty !== 1 ? 's' : ''} · ${money(o.total)} · ${fmtDateTime(o.createdAt)}
        </div>
      </div>`).join('')
}

async function manualLink(raw) {
  const code = cleanText(raw, 64).toLowerCase()
  if (!code) return
  if (state.link?.id) await LINKS().delete(state.link.id)
  const promo = findByUsername(code)
  if (!promo) {
    err('Promotor no encontrado · verificá el código')
    haptic([40, 60, 40])
    return
  }
  const at = Date.now()
  const link = { id: uid(), desk: getDesk(), promoterId: promo.username, at, expiresAt: at + LINK_TTL }
  await LINKS().put(link)
  state.mode = 'list'
  state.promoter = link.promoterId
  state.link = link
  state.items = {}
  state.client = ''
  state.q = ''
  haptic([40, 40])
  ok(`Sesión vinculada · promotor ${link.promoterId}`)
  renderList()
}

function renderList() {
  const q = state.q.toLowerCase()
  const items = [...catalog].sort((a, b) => (a.order || 0) - (b.order || 0))
  const filtered = q ? items.filter((p) => (p.name || '').toLowerCase().includes(q)) : items
  const selected = Object.entries(state.items).filter(([, n]) => n > 0)
  const total = selected.reduce((acc, [pid, n]) => {
    const prod = catalog.find((c) => c.id === pid)
    return acc + (prod ? prod.price * n : 0)
  }, 0)
  const count = selected.reduce((a, [, n]) => a + n, 0)

  mainEl.innerHTML = `
    <div class="v-list pop-in">
      <div class="v-list-head">
        <div class="grow">
          <div class="v-eyebrow">Nueva venta</div>
          <h2>Promotor <span class="v-promoter">${esc(state.promoter)}</span></h2>
        </div>
        <button class="btn btn--sm btn--ghost" id="v-unlink" type="button">Desvincular</button>
      </div>

      <div class="search">
        ${icon('search', 18, 2)}
        <input class="input" id="v-q" placeholder="Buscar artículo…" autocomplete="off" />
      </div>

      <div class="v-cat">
        <div class="vlist" id="v-items">
          ${filtered.length ? filtered.map((p) => {
            const n = state.items[p.id] || 0
            return `
            <div class="row-item">
              <div class="row-thumb">${icon('tag', 18, 1.8)}</div>
              <div class="row-main">
                <div class="row-title">${esc(p.name)}</div>
                <div class="row-sub">${categoryOf(p.category).label} · ${money(p.price)} por día</div>
              </div>
              <span class="amount v-line" data-line="${p.id}" ${n ? '' : 'hidden'}>${money(p.price * n)}</span>
              <div class="stepper">
                <button data-dec="${p.id}" type="button" aria-label="Menos">−</button>
                <span class="sv">${n}</span>
                <button data-inc="${p.id}" type="button" aria-label="Más">+</button>
              </div>
            </div>`
          }).join('') : `<div class="empty" style="grid-column:1 / -1">${icon('search', 38, 1.4)}<h4>Sin resultados</h4></div>`}
        </div>
      </div>

      <div class="v-footer">
        <div class="grow">
          <div class="mutest" style="font-size:12px">${count} ${count === 1 ? 'artículo' : 'artículos'}</div>
          <div class="v-total amount">${money(total)}</div>
        </div>
        <div class="field grow" style="min-width:200px">
          <label for="v-client">Cliente (TITULAR)</label>
          <input class="input" id="v-client" placeholder="Nombre del cliente…" value="${esc(state.client)}" autocomplete="off" />
        </div>
        <button class="btn btn--success btn--lg" id="v-order" type="button" ${count && state.client.trim() ? '' : 'disabled'}>
          ${icon('ticket', 18, 2)} Ordenar
        </button>
      </div>
    </div>
  `

  mainEl.querySelector('#v-q').value = state.q
  mainEl.querySelector('#v-client').value = state.client
  mainEl.querySelector('#v-client').addEventListener('input', (e) => {
    state.client = e.target.value
    const btn = mainEl.querySelector('#v-order')
    btn.disabled = !(Object.values(state.items).reduce((a, n) => a + n, 0) && state.client.trim())
  })
  mainEl.querySelector('#v-q').addEventListener('input', (e) => {
    state.q = e.target.value
    renderList()
  })
  mainEl.querySelector('#v-unlink').addEventListener('click', async () => {
    if (state.link?.id) await LINKS().delete(state.link.id)
    state.promoter = null
    state.link = null
    state.items = {}
    state.client = ''
    state.q = ''
    goLink(true)
  })
  mainEl.querySelectorAll('[data-inc]').forEach((b) => {
    b.addEventListener('click', () => stepItem(b.dataset.inc, +1))
  })
  mainEl.querySelectorAll('[data-dec]').forEach((b) => {
    b.addEventListener('click', () => stepItem(b.dataset.dec, -1))
  })
  mainEl.querySelector('#v-order').addEventListener('click', handleOrdered)
  const qIn = mainEl.querySelector('#v-q')
  qIn.focus({ preventScroll: true })
}

function stepItem(id, delta) {
  const cur = state.items[id] || 0
  state.items[id] = Math.max(0, cur + delta)
  if (!state.items[id]) delete state.items[id]
  const row = mainEl.querySelector(`[data-dec="${id}"]`)
  if (row) {
    const parent = row.closest('.row-item')
    const prod = catalog.find((c) => c.id === id)
    parent.querySelector('.sv').textContent = state.items[id] || 0
    const line = parent.querySelector(`[data-line="${id}"]`)
    line.hidden = !state.items[id]
    line.textContent = money((prod ? prod.price * state.items[id] : 0))
  }
  const orderBtn = mainEl.querySelector('#v-order')
  const count = Object.values(state.items).reduce((a, n) => a + n, 0)
  orderBtn.disabled = !(count && state.client.trim())
  orderBtn.innerHTML = `${icon('ticket', 18, 2)} Ordenar${count ? ` · ${count}` : ''}`
  const total = Object.entries(state.items).reduce((acc, [pid, n]) => {
    const prod = catalog.find((c) => c.id === pid)
    return acc + (prod ? prod.price * n : 0)
  }, 0)
  mainEl.querySelector('.v-total').textContent = money(total)
  const cnt = mainEl.querySelector('.mutest')
  if (cnt) cnt.textContent = `${count} ${count === 1 ? 'artículo' : 'artículos'}`
}

function goLink(resetAll = false) {
  state.mode = 'link'
  state.promoter = null
  state.link = null
  state.items = {}
  state.client = ''
  state.q = ''
  if (resetAll) state.lastOrder = null
  renderLink()
}

async function onDataChange() {
  if (!rootEl) return
  if (state.mode === 'link') {
    const link = resolveLink()
    if (link && state.promoter !== link.promoterId) {
      state.mode = 'list'
      state.promoter = link.promoterId
      state.link = link
      state.items = {}
      state.client = ''
      state.q = ''
      haptic([40, 40])
      renderList()
    }
  } else {
    const link = state.link
    if (link) {
      const live = await LINKS().get(link.id)
      if (!live || Date.now() - live.at > LINK_TTL || (live.expiresAt && Date.now() > live.expiresAt)) {
        goLink(true)
        return
      }
    }
    renderSent()
  }
}

function stopDataSync() {
  dataOff?.()
  dataOff = null
}

export function ventasView() {
  const mount = async (root) => {
    rootEl = root
    const s = getSession()
    await load()

    root.innerHTML = `
      <div class="screen v-screen">
        <header class="topbar">
          <div class="row" style="gap:10px">
            <div class="row-thumb" style="width:34px;height:34px;border-radius:10px">${icon('tag', 17, 2)}</div>
            <div class="grow">
              <div class="row-title" style="font-size:15px">${s.role.short} · ${s.username}</div>
              <div class="row-sub">Puesto ${getDesk()} · turno desde ${s.loginAt ? fmtDateTime(s.loginAt) : ''}</div>
            </div>
          </div>
          <button class="icon-btn" id="logout" title="Cerrar sesión" aria-label="Cerrar sesión">${icon('arrowleft', 18, 2)}</button>
        </header>
        <main class="v-main" id="v-main"></main>
      </div>
    `

    mainEl = root.querySelector('#v-main')
    root.querySelector('#logout').addEventListener('click', () => {
      stopDataSync()
      logout()
      navigate('login', true)
    })

    dataOff?.()
    dataOff = subscribeData(onDataChange)

    await purgeLinks()

    const link = resolveLink()
    if (link) {
      state.mode = 'list'
      state.promoter = link.promoterId
      state.link = link
      state.items = {}
      state.client = ''
      state.q = ''
      renderList()
    } else {
      goLink(true)
    }
  }

  const unmount = () => {
    stopDataSync()
    rootEl = null
    mainEl = null
  }

  return { mount, unmount }
}