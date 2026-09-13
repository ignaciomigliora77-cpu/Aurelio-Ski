import { getSession, ensureSessionActive } from './auth/index.js'

const ROUTES = [
  { path: 'login', public: true, load: () => import('./auth/login.js').then((m) => m.loginView()) },
  { path: 'promotor', role: 'promotor', load: () => import('./views/promotor/index.js').then((m) => m.promotorView()) },
  { path: 'ventas', role: 'ventas', load: () => import('./views/ventas/index.js').then((m) => m.ventasView()) },
  { path: 'equipo', role: 'equipo', load: () => import('./views/rental/index.js').then((m) => m.rentalView('equipo')) },
  { path: 'botas', role: 'botas', load: () => import('./views/rental/index.js').then((m) => m.rentalView('botas')) },
  { path: 'ropa', role: 'ropa', load: () => import('./views/rental/index.js').then((m) => m.rentalView('ropa')) },
  { path: 'recepcion', role: 'recepcion', load: () => import('./views/recepcion/index.js').then((m) => m.recepcionView()) },
]

let current = null
let rendering = false

export const currentPath = () =>
  (window.location.hash || '#/login').replace(/^#\/?/, '').split('?')[0] || 'login'

function matchRoute(name) {
  return ROUTES.find((r) => r.path === name) || ROUTES[0]
}

export function navigate(path, force = false) {
  const target = `#/${path}`
  if (window.location.hash === target && !force) return
  window.location.hash = target
}

export async function renderRoute() {
  if (rendering) return
  rendering = true
  try {
    const name = currentPath()
    const route = matchRoute(name)
    const session = getSession()

    if (!route.public) {
      if (!(await ensureSessionActive())) {
        navigate('login', true)
        return
      }
      const session = getSession()
      if (!session || session.role.id !== route.role) {
        navigate(session?.role.tab || 'login', true)
        return
      }
    } else if (route.path === 'login' && session) {
      navigate(session.role.tab, true)
      return
    }

    if (current && current.route === name) return

    if (current && typeof current.unmount === 'function') current.unmount()

    const view = await route.load()
    const app = document.querySelector('#app')
    app.innerHTML = ''
    current = { ...view, route: name }
    view.mount(app)
    window.scrollTo(0, 0)
  } finally {
    rendering = false
  }
}

export function startRouter() {
  window.addEventListener('hashchange', renderRoute)
  renderRoute()
}