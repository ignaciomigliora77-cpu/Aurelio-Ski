export const ITERS = 150000

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const pbkdf2 = async (password, salt, iterations) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
}

const pack = (iters, salt, hashB64) => `pbkdf2$${iters}$${b64(salt)}$${hashB64}`

export const unpackStored = (s) => {
  const m = /^pbkdf2\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(s || ''))
  return m ? { iters: +m[1], salt: unb64(m[2]), hashB64: m[3] } : null
}

export const hashPassword = async (password) => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await pbkdf2(password, salt, ITERS)
  return pack(ITERS, salt, b64(bits))
}

export async function verifyPassword(password, stored) {
  const p = unpackStored(stored)
  if (!p) return { match: stored === password, legacy: true }
  const bits = await pbkdf2(password, p.salt, p.iters)
  return { match: b64(bits) === p.hashB64, legacy: false, stored }
}

export async function verifySessionCred(session, password) {
  const p = unpackStored(session?.cred?.stored)
  if (!p) return false
  const bits = await pbkdf2(password, p.salt, p.iters)
  return b64(bits) === p.hashB64
}

export const signedToken = (action, target, actor, nonce, expiresAt) =>
  sha256hex([action, target || '', actor || '-', nonce, expiresAt].join('|'))

export const sha256hex = async (str) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifySignedToken(action, target, actor, nonce, expiresAt, token) {
  if (Date.now() > expiresAt) return false
  const expect = await signedToken(action, target, actor, nonce, expiresAt)
  return expect === token
}