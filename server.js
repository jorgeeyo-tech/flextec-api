const express = require('express')
const cors    = require('cors')
const fetch   = require('node-fetch')

const app = express()
app.use(express.json({ limit: '20mb' }))  // PDFs en base64 son grandes

// ── CORS — solo permite llamadas desde FlexTec ────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://flextec.crmfreelance.com',
  'http://localhost:5173',
  'http://localhost:4173',
]
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true)
    else cb(new Error('CORS: origen no permitido'))
  }
}))

// ── Variables de entorno (configuradas en Railway) ────────────────────────────
const MAERSK_KEY      = process.env.MAERSK_KEY
const MAERSK_SECRET   = process.env.MAERSK_SECRET
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY
const MAERSK_BASE     = 'https://api.maersk.com'
const ANTHROPIC_BASE  = 'https://api.anthropic.com'

// ── Cache de token Maersk ─────────────────────────────────────────────────────
let maerskToken = { value: null, expires: 0 }

async function getMaerskToken() {
  if (maerskToken.value && Date.now() < maerskToken.expires) {
    return maerskToken.value
  }
  const res = await fetch(`${MAERSK_BASE}/customer-identity/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${MAERSK_KEY}&client_secret=${MAERSK_SECRET}`
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('No se pudo obtener token de Maersk')
  maerskToken = {
    value: data.access_token,
    expires: Date.now() + (data.expires_in - 300) * 1000
  }
  return maerskToken.value
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — estado del servidor
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    service: 'FlexTec API',
    maersk:    MAERSK_KEY    ? 'configurado' : 'FALTA',
    anthropic: ANTHROPIC_KEY ? 'configurado' : 'FALTA',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /ports?q=vigo — Buscar puertos via Maersk Locations API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/ports', async (req, res) => {
  const { q = '', limit = 8 } = req.query
  if (q.length < 2) return res.json([])

  try {
    const token = await getMaerskToken()
    const url = `${MAERSK_BASE}/locations?locationType=Port&portNameStartsWith=${encodeURIComponent(q)}&limit=${limit}`
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Consumer-Key': MAERSK_KEY
      }
    })
    const data = await r.json()
    const ports = (Array.isArray(data) ? data : []).map(p => ({
      name:        p.name || '',
      code:        p.UNLocationCode || '',
      country:     p.countryCode || '',
      countryName: p.countryName || '',
    }))
    res.json(ports)
  } catch (err) {
    console.error('Error /ports:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat — Proxy seguro hacia Claude (Anthropic)
//
// Body esperado:
// {
//   messages: [...],          // historial de mensajes
//   system:   "...",          // prompt del sistema (opcional, lo pone FlexTec)
//   max_tokens: 8000,         // opcional, default 8000
//   pdf: { b64: "...", name: "..." }  // opcional, PDF adjunto
// }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { messages, system, max_tokens = 8000, pdf } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages es obligatorio y debe ser un array' })
  }

  try {
    // Si viene un PDF, añadirlo al último mensaje del usuario
    let finalMessages = [...messages]
    if (pdf?.b64) {
      const lastUser = finalMessages.filter(m => m.role === 'user').pop()
      if (lastUser) {
        // Convertir el mensaje de texto a multimodal con el PDF
        const idx = finalMessages.lastIndexOf(lastUser)
        const content = typeof lastUser.content === 'string'
          ? [{ type: 'text', text: lastUser.content }]
          : [...lastUser.content]
        content.unshift({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdf.b64 },
          title: pdf.name || 'documento.pdf'
        })
        finalMessages[idx] = { ...lastUser, content }
      }
    }

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens,
      messages: finalMessages,
    }
    if (system) body.system = system

    const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body)
    })

    const data = await r.json()

    // Reenviar la respuesta de Claude tal cual a FlexTec
    res.status(r.status).json(data)

  } catch (err) {
    console.error('Error /chat:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Arrancar
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ FlexTec API corriendo en puerto ${PORT}`)
  console.log(`   MAERSK_KEY:    ${MAERSK_KEY    ? '✓' : '✗ FALTA'}`)
  console.log(`   ANTHROPIC_KEY: ${ANTHROPIC_KEY ? '✓' : '✗ FALTA'}`)
})
