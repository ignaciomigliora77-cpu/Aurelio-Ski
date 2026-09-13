const CH = 'aurelio-sync'

let chan = null
const bc = () => {
  if (chan) return chan
  try {
    chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CH) : null
  } catch {
    chan = null
  }
  return chan
}

export const syncNotify = () => {
  try {
    bc()?.postMessage({ type: 'REFRESH_SUMMARY', at: Date.now() })
  } catch {
    /* noop */
  }
}

export const onSync = (fn) => {
  const c = bc()
  if (!c) return () => {}
  const handler = (e) => {
    if (e.data?.type === 'REFRESH_SUMMARY') fn(e.data)
  }
  c.addEventListener('message', handler)
  return () => {
    try {
      c.removeEventListener('message', handler)
    } catch {
      /* noop */
    }
  }
}

export const onSummary = (fn) => {
  const c = bc()
  if (!c) return () => {}
  c.onmessage = (e) => {
    if (e.data?.type === 'REFRESH_SUMMARY') fn(e.data)
  }
  return () => {
    try {
      c.onmessage = null
    } catch {
      /* noop */
    }
  }
}