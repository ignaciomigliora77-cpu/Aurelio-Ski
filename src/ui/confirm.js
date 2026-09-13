import { getSession, verifySessionCred } from '../auth/index.js'
import { signedToken } from '../auth/crypto.js'
import { openSheet, err, esc, uid } from './components.js'
import { icon } from './icons.js'

export const TOKEN_TTL = 30000

export function confirmCritical({ action, target, word, note }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const s = getSession()
    const expected = String(word || 'ELIMINAR').toUpperCase()
    const { close, root } = openSheet({
      title: 'Confirmación de seguridad',
      body: `
        <p class="mutest" style="font-size:12px;line-height:1.5">
          Operación sensible · puesto <b>${esc(s?.username || '—')}</b>. Se exige re-autenticación
          con la contraseña del administrador, control de integridad criptográfica y tipeo exacto
          de la palabra de confirmación. Toda la acción queda registrada en auditoría.
          ${note ? `<br><span style="color:var(--text-2)">${esc(note)}</span>` : ''}
        </p>
        <div class="stack" style="gap:14px;margin-top:14px">
          <div class="field">
            <label for="cf-pass">Contraseña del administrador</label>
            <input class="input" id="cf-pass" type="password" autocomplete="off" autofocus />
          </div>
          <div class="field">
            <label for="cf-word">Escribí exactamente <b style="letter-spacing:.02em">${esc(expected)}</b> para ejecutar</label>
            <input class="input" id="cf-word" autocapitalize="none" spellcheck="false" autocomplete="off" />
          </div>
        </div>
      `,
      footer: `<button class="btn btn--danger btn--lg" id="cf-go" disabled type="button">${icon('trash', 17, 2)} Ejecutar ${esc(expected)}</button>`,
      onClose: () => finish(null),
    })

    const pass = root.querySelector('#cf-pass')
    const wrd = root.querySelector('#cf-word')
    const go = root.querySelector('#cf-go')

    const update = () => {
      go.disabled = !(pass.value.trim() && wrd.value.trim().toUpperCase() === expected)
    }
    pass.addEventListener('input', update)
    wrd.addEventListener('input', update)

    go.addEventListener('click', async () => {
      const okc = await verifySessionCred(pass.value)
      if (!okc) {
        err('Contraseña incorrecta · no se ejecutó la acción')
        pass.value = ''
        pass.focus()
        return
      }
      const nonce = uid()
      const expiresAt = Date.now() + TOKEN_TTL
      const token = await signedToken(action, target || '', s.username, nonce, expiresAt)
      finish({ action, target: target || '', nonce, expiresAt, token })
      close()
    })
  })
}

export async function assertToken(tok, action, target) {
  const s = getSession()
  if (!tok || !tok.token) throw new Error('TOKEN_FALTANTE')
  if (Date.now() > tok.expiresAt) throw new Error('TOKEN_EXPIRADO')
  const expect = await signedToken(action, target || '', s.username, tok.nonce, tok.expiresAt)
  if (tok.token !== expect) throw new Error('TOKEN_INVALIDO')
}