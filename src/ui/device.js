/* Snapshot de dispositivo 100% nativo y síncrono.
   Sin geolocalización, sin trackers de IP, sin APIs externas. Se computa una
   sola vez (caché lazy) y se anexa al `detail` de cada entrada de auditoría. */

let cached = null

export const deviceSnap = () => {
  if (cached) return cached

  const ua = navigator.userAgent || ''
  const uaData = navigator.userAgentData
  const platform = uaData?.platform || navigator.platform || ''

  let os
  if (/iPad|iPhone|iPod/.test(ua) && !/Mac/.test(platform)) os = 'iOS'
  else if (uaData?.platform) os = uaData.platform
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Mac/.test(ua)) os = 'macOS'
  else if (/Linux/.test(ua)) os = 'Linux'
  else os = 'Otro'

  const coarseTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

  cached = {
    ua: (ua.replace(/^Mozilla\/5\.0\s*/, '') || ua).slice(0, 80),
    os,
    screen: `${window.screen.width}x${window.screen.height}`,
    touch: coarseTouch ? 'si' : 'no',
  }
  return cached
}