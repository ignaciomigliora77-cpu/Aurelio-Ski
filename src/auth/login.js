import { icon } from '../ui/icons.js'
import { login, getSession } from './index.js'
import { navigate } from '../router.js'
import { haptic } from '../ui/components.js'

const LOGO = '/favicon.svg'

export function loginView() {
  const mount = (root) => {
    root.innerHTML = `
      <div class="login-screen pop-in">
        <div class="login-card">
          <div class="login-logo">
            <img src="${LOGO}" alt="Aurelio SKI" />
            <div>
              <div class="title">Aurelio SKI</div>
              <p class="subtitle">Centro de esquí · Alta montaña</p>
            </div>
          </div>

          <div class="field">
            <label for="username">Usuario</label>
            <input id="username" class="input" autocomplete="username"
                   autocapitalize="none" spellcheck="false"
                   placeholder="usuario" />
          </div>

          <div class="field">
            <label for="password">Contraseña</label>
            <div class="pass-wrap">
              <input id="password" class="input" type="password"
                     autocomplete="current-password"
                     placeholder="••••••••" spellcheck="false" />
              <button class="pass-toggle" id="pass-toggle" type="button" aria-label="Mostrar contraseña">${icon('eye', 17, 2)}</button>
            </div>
          </div>

          <div id="login-error"></div>

          <button id="go" class="btn btn--primary btn--lg" type="button">Ingresar</button>
        </div>
      </div>
    `

    const userInput = root.querySelector('#username')
    const passInput = root.querySelector('#password')
    const passToggle = root.querySelector('#pass-toggle')
    const errorBox = root.querySelector('#login-error')
    const goBtn = root.querySelector('#go')

    let showPass = false
    passToggle.addEventListener('click', () => {
      showPass = !showPass
      passInput.type = showPass ? 'text' : 'password'
      passToggle.innerHTML = icon(showPass ? 'eye-off' : 'eye', 17, 2)
      passToggle.setAttribute('aria-label', showPass ? 'Ocultar contraseña' : 'Mostrar contraseña')
    })

    const submit = async () => {
      errorBox.innerHTML = ''
      goBtn.disabled = true
      goBtn.textContent = 'Validando…'
      try {
        await login(userInput.value.trim().toLowerCase(), passInput.value)
        haptic([18, 30])
        navigate(getSession().role.tab, true)
      } catch (e) {
        errorBox.innerHTML = `
          <div class="login-error">
            ${icon('xmark', 16, 2.2)}
            <span>Credenciales incorrectas · verificá usuario y contraseña</span>
          </div>`
        haptic([40, 60, 40])
        passInput.value = ''
        passInput.focus()
      } finally {
        goBtn.disabled = false
        goBtn.textContent = 'Ingresar'
      }
    }

    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') passInput.focus()
    })
    passInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit()
    })
    goBtn.addEventListener('click', submit)
    setTimeout(() => userInput.focus(), 120)
  }

  return { mount, unmount() {} }
}