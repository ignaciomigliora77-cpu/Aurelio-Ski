import { icon } from '../ui/icons.js'

/*
 * Dock flotante estilo iOS/WhatsApp (Vanilla JS puro).
 * Componente puro de presentación: recibe items + estado activo y delega la
 * navegación al llamador (sin recargas, sin estado interno de datos).
 *
 * Uso:
 *   mountDock(host, {
 *     items: [{ id, label, icon }],
 *     active: 'aprobacion',
 *     onSelect: (id) => { ... },
 *     count: (id) => 3,          // opcional: badge numérico
 *   })
 */
export function mountDock(host, { items, active, onSelect, count }) {
  host.innerHTML = items
    .map((t) => {
      const badge = count?.(t.id)
      return `
        <button class="dock-item ${active === t.id ? 'active' : ''}" data-tab="${t.id}" type="button" aria-label="${t.label}" title="${t.label}">
          ${icon(t.icon, 23, 1.8)}
          <span>${t.label}</span>
          ${badge ? `<span class="count-badge">${badge}</span>` : '<span class="dot"></span>'}
        </button>`
    })
    .join('')

  host.querySelectorAll('[data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      if (active !== b.dataset.tab) onSelect?.(b.dataset.tab)
    })
  })
}