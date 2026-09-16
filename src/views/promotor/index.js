import { getSession, logout } from '../../auth/index.js'
import { navigate } from '../../router.js'
import { icon } from '../../ui/icons.js'
import { mountDock } from '../../components/Dock.js'
import { fmtTime, haptic } from '../../ui/components.js'
import './promotor.css'

const TABS = [
  { id: 'scanner', label: 'Escáner', icon: 'camera' },
  { id: 'stats', label: 'Estadísticas', icon: 'chart' },
]

let active = 'scanner'
let currentView = null
let rootEl = null
let dockEl = null
let tabRoot = null

async function loadView(id) {
  switch (id) {
    case 'scanner':
      return import('./scanner.js').then((m) => m.scannerView())
    case 'stats':
      return import('./stats.js').then((m) => m.statsView())
  }
}

function renderDock() {
  mountDock(dockEl, {
    items: TABS,
    active,
    onSelect: (id) => {
      haptic(10)
      switchTab(id)
    },
  })
}

async function switchTab(id) {
  if (currentView?.unmount) currentView.unmount()
  active = id
  tabRoot.innerHTML = ''
  renderDock()
  const view = await loadView(id)
  currentView = view
  view.mount(tabRoot)
}

export function promotorView() {
  const mount = (root) => {
    rootEl = root
    const s = getSession()
    root.innerHTML = `
      <div class="screen">
        <header class="topbar">
          <div class="row" style="gap:10px">
            <div class="row-thumb" style="width:34px;height:34px;border-radius:10px">${icon('person', 17, 2)}</div>
            <div class="grow">
              <div class="row-title" style="font-size:15px">${s.role.short} · ${s.username}</div>
              <div class="row-sub">Turno desde ${fmtTime(s.loginAt)}</div>
            </div>
          </div>
          <button class="icon-btn" id="logout" title="Cerrar sesión" aria-label="Cerrar sesión">${icon('arrowleft', 18, 2)}</button>
        </header>

        <main class="content content-feed" id="tab-root"></main>

        <div class="dock-wrap">
          <nav class="dock" id="dock" aria-label="Navegación"></nav>
        </div>
      </div>
    `

    tabRoot = root.querySelector('#tab-root')
    dockEl = root.querySelector('#dock')

    root.querySelector('#logout').addEventListener('click', async () => {
      await logout()
      navigate('login', true)
    })

    renderDock()
    switchTab('scanner')

    root.__cleanup = () => {}
  }

  const unmount = () => {
    if (currentView?.unmount) currentView.unmount()
    currentView = null
    rootEl?.__cleanup?.()
    rootEl = null
  }

  return { mount, unmount }
}