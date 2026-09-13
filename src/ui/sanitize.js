export const cleanText = (s, max = 80) =>
  String(s ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

export const slugUser = (s) => {
  const v = cleanText(s, 24).toLowerCase().replace(/[^a-z0-9._-]/g, '')
  return /^[a-z0-9][a-z0-9._-]{2,23}$/.test(v) ? v : null
}

export const passValid = (s) => {
  const v = String(s ?? '')
  if (v.length < 6 || v.length > 128 || /[\u0000-\u001F\u007F]/.test(v)) return null
  return v
}

export const cleanDoc = (s) =>
  String(s ?? '')
    .replace(/[^a-zA-Z0-9.\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 30)

export const cleanMoney = (s) => {
  const n = parseFloat(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export const cleanInt = (s) => {
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}