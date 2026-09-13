import QRCode from 'qrcode'

export function initQrCanvas(canvas, text, size = 168) {
  QRCode.toCanvas(
    canvas,
    text,
    {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' },
    },
  ).catch(() => {
    /* QR fallback: no se pudo dibujar */
  })
}