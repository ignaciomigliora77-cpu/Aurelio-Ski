import jsQR from 'jsqr'
import { LINKS, ORDERS } from '../../db/index.js'
import { getSession } from '../../auth/index.js'
import { icon } from '../../ui/icons.js'
import { fmtTime, haptic, ok, err, toast, uid } from '../../ui/components.js'

let stream = null
let loopId = null
let busy = false
let cooldown = false
let resumeId = null
let root = null
let detector = null
let starting = false
let video, canvas, ctx, manualInput, validarBtn

const LINK_TTL = 120000

const isSupported = () => {
  try {
    return !!navigator.mediaDevices?.getUserMedia
  } catch {
    return false
  }
}

const normalize = (raw) => String(raw || '').trim().toUpperCase().replace(/\u200b/g, '')

const cameraErrMessage = (e) => {
  const name = e?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permiso de cámara denegado · habilitalo en el navegador'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No se detectó ninguna cámara en este dispositivo · usá el código manual'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'La cámara está en uso por otra app · cerrá la otra y reintentá'
  if (name === 'OverconstrainedError') return 'No hay una cámara compatible · usá la trasera o el código manual'
  return 'No se pudo iniciar la cámara · usá el código manual o reintentá'
}

const cameraErrTitle = (e) => {
  const name = e?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permiso de cámara denegado'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Cámara no encontrada'
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Cámara en uso'
  if (name === 'OverconstrainedError') return 'Cámara no compatible'
  return 'No se pudo iniciar la cámara'
}

function overlayEl() {
  return root?.querySelector('#sc-overlay')
}

function showOverlay() {
  const ov = overlayEl()
  if (ov) ov.hidden = false
}

function hideOverlay() {
  const ov = overlayEl()
  if (ov) ov.hidden = true
}

function setOverlay(title, sub) {
  const ov = overlayEl()
  if (!ov) return
  ov.querySelector('#sc-ov-title').textContent = title
  ov.querySelector('#sc-ov-sub').textContent = sub || ''
}

async function handleScan(raw) {
  const code = normalize(raw)
  if (!code || busy) return
  if (code.startsWith('VENTAS::')) {
    await linkTablet(code)
    return
  }
  await validateOrder(code)
}

async function linkTablet(code) {
  busy = true
  try {
    const desk = code.replace('VENTAS::', '')
    const s = getSession()
    const at = Date.now()
    await LINKS().add({ id: uid(), desk, promoterId: s.username, at, expiresAt: at + LINK_TTL })
    haptic([30, 50, 80])
    ok(`Ventas vinculada · Tablet ${desk} — podés seleccionar los artículos en la pantalla de Ventas`)
  } finally {
    busy = false
    armResume()
  }
}

async function validateOrder(code) {
  busy = true
  try {
    const order = await ORDERS().where('code').equals(code).first()
    if (!order) {
      haptic([50])
      err(`Código no reconocido · ${code}`)
      armResume(1600)
      return
    }
    const approved = order.state === 'aprobada'
    if (!approved) {
      haptic([18, 60, 18])
      toast(`${order.code} aguarda el visto bueno de Recepción`)
      armResume()
      return
    }
    haptic([30, 50, 80])
    const when = fmtTime(order.approvedAt || order.createdAt)
    ok(`${order.code} aprobada · ${when} · ${order.itemQty} ítem${order.itemQty !== 1 ? 's' : ''} · ${'$ ' + order.total.toLocaleString('es-AR')}`)
    armResume()
  } finally {
    busy = false
  }
}

function armResume(delay = 2500) {
  if (resumeId) clearTimeout(resumeId)
  resumeId = setTimeout(() => {
    resumeId = null
    cooldown = false
    if (!loopId && stream) loopId = setInterval(tick, 300)
  }, delay)
}

async function startCamera() {
  if (!isSupported()) {
    setOverlay('Cámara no disponible', 'Este dispositivo no expone cámara · usá el código manual.')
    showOverlay()
    return
  }
  if (starting) return
  starting = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    })
    video.srcObject = stream
    hideOverlay()
    /* play() no se espera: un rechazo de autoplay (Safari iOS) NO debe matar
       el stream ni mostrar un error falso. tick() reintenta el play mientras
       el stream siga vivo. El estado del visor depende SOLO del stream. */
    const p = video.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
    loopId = setInterval(tick, 300)
    haptic(12)
  } catch (e) {
    stopCamera()
    setOverlay(cameraErrTitle(e), cameraErrMessage(e))
    showOverlay()
  } finally {
    starting = false
  }
}

function stopCamera() {
  if (resumeId) clearTimeout(resumeId)
  resumeId = null
  if (loopId) clearInterval(loopId)
  loopId = null
  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
    stream = null
  }
  if (video) {
    video.srcObject = null
  }
}

function pauseCamera() {
  if (loopId) clearInterval(loopId)
  loopId = null
}

async function resumeCamera() {
  if (!root || document.hidden) return
  if (stream) {
    loopId = setInterval(tick, 300)
    if (video && !video.videoWidth) video.play().catch(() => {})
  } else {
    await startCamera()
  }
}

async function requestPermissionAndStart() {
  try {
    const cam = await navigator.permissions?.query({ name: 'camera' })
    cam?.addEventListener?.('change', () => {
      if (cam.state === 'granted' && root) startCamera()
    })
    if (cam?.state === 'granted') {
      startCamera()
      return
    }
  } catch {
    /* query no soportado: se intenta directo el stream */
  }
  startCamera()
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseCamera()
  else resumeCamera()
})

async function tick() {
  if (!video || busy || cooldown) return
  if (!video.videoWidth) {
    if (stream && document.visibilityState !== 'hidden') video.play().catch(() => {})
    return
  }
  try {
    if ('BarcodeDetector' in window) {
      detector = detector || new BarcodeDetector({ formats: ['qr_code'] })
      const codes = await detector.detect(video)
      if (codes.length) {
        cooldown = true
        await handleScan(codes[0].rawValue)
      }
    } else {
      if (!canvas) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
      if (res && res.data) {
        cooldown = true
        await handleScan(res.data)
      }
    }
  } catch {
    /* frame de lectura descartado */
  }
}

export function scannerView() {
  const mount = async (el) => {
    root = el
    await LINKS().filter((l) => !l.expiresAt || l.expiresAt < Date.now()).delete()
    root.innerHTML = `
      <div class="scanner-shell">
        <div class="scanner-viewport">
          <video id="sc-video" playsinline muted autoplay webkit-playsinline></video>
          <canvas id="sc-canvas" hidden></canvas>
          <div class="scanner-scanline"></div>
          <div class="scanner-corners"><span></span><span></span><span></span><span></span></div>
          <div class="scanner-overlay" id="sc-overlay" hidden>
            <div class="scanner-overlay-inner">
              <div class="scanner-overlay-icon">${icon('camera', 26, 2)}</div>
              <div class="scanner-overlay-title" id="sc-ov-title">Cámara inactiva</div>
              <div class="scanner-overlay-sub" id="sc-ov-sub"></div>
              <button class="btn btn--accent" id="sc-start" type="button">${icon('camera', 18, 2)} Activar cámara</button>
            </div>
          </div>
        </div>

        <div class="scan-manual">
          <div class="row" style="width:min(100%,380px);align-items:stretch">
            <div class="search grow">
              ${icon('search', 18, 2)}
              <input class="input" id="sc-manual" placeholder="Código manual · VENTAS o Nº de venta" autocomplete="off" spellcheck="false" />
            </div>
            <button class="btn btn--primary" id="validar-btn" type="button" disabled>Validar</button>
          </div>
          <p class="mutest" style="font-size:12px;text-align:center;margin-top:8px">Si la cámara no lee el código, ingresalo acá manualmente.</p>
        </div>
      </div>
    `

    video = root.querySelector('#sc-video')
    canvas = root.querySelector('#sc-canvas')
    ctx = canvas.getContext('2d', { willReadFrequently: true })
    manualInput = root.querySelector('#sc-manual')
    validarBtn = root.querySelector('#validar-btn')

    const doManual = async () => {
      if (!manualInput.value.trim()) return
      cooldown = true
      await handleScan(manualInput.value)
      manualInput.select()
    }
    validarBtn.addEventListener('click', doManual)
    manualInput.addEventListener('input', () => {
      validarBtn.disabled = !manualInput.value.trim()
    })
    manualInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doManual()
    })

    root.querySelector('#sc-start').addEventListener('click', startCamera)
    setOverlay('Cámara inactiva', 'Activá la cámara para escanear el código QR, o usá el ingreso manual.')
    showOverlay()
    requestPermissionAndStart()
  }

  const unmount = () => {
    stopCamera()
    root = null
    video = null
    canvas = null
    ctx = null
    manualInput = null
    validarBtn = null
  }

  return { mount, unmount }
}