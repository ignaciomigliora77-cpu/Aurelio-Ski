import { openSheet, openPopover, esc } from '../ui/components.js'
import { icon } from '../ui/icons.js'

/*
 * Modal de detalle genérico (Vanilla JS puro).
 * PROHIBIDO expandir ítems inline: se abre un modal flotante según viewport:
 *  - Móvil  (<=640px) -> Bottom Sheet (clase .sheet, glass)
 *  - Escritorio       -> Popover centrado (clase .popover, glass)
 *
 * Uso:
 *   openDetail({
 *     title: 'Ver detalle · VT-1234',
 *     rows: [{ icon: 'tag', name, sub, value }],
 *     footer: '<button …>',
 *   })
 */
const isMobile = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches

export function openDetail({ title, rows = [], footer, onClose } = {}) {
  const body = `
    <div class="detail-modal">
      ${rows.length
        ? rows
            .map(
              (r) => `
            <div class="detail-row">
              ${r.icon ? `<div class="row-thumb">${icon(r.icon, 18, 1.8)}</div>` : ''}
              <div class="row-main">
                <div class="row-title">${esc(r.name)}</div>
                ${r.sub ? `<div class="row-sub">${r.sub}</div>` : ''}
              </div>
              ${r.value ? `<span class="amount num-tabular" style="font-weight:600">${r.value}</span>` : ''}
            </div>`
            )
            .join('')
        : '<p class="mutest" style="font-size:13px">Sin líneas.</p>'}
    </div>`

  const modal = isMobile()
    ? openSheet({ title, body, footer, onClose })
    : openPopover({ title, body, footer, onClose })
  return modal
}