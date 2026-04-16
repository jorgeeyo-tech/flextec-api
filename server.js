const express = require('express')
const cors    = require('cors')
const fetch   = require('node-fetch')
const { createClient } = require('@supabase/supabase-js')
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
const MAERSK_BASE     = 'https://api.maersk.com/maersk-locations/v2'
const ANTHROPIC_BASE  = 'https://api.anthropic.com'
const TRACKCARGO_KEY = process.env.TRACKCARGO_API_KEY
const TRACKCARGO_API = 'https://api.trackcargo.co/v1'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)
// ── Cache de token Maersk ─────────────────────────────────────────────────────
let maerskToken = { value: null, expires: 0 }

async function getMaerskToken() {
  if (maerskToken.value && Date.now() < maerskToken.expires) {
    return maerskToken.value
  }
  // Maersk Open APIs usan el Consumer Key directamente en el header
  // No necesitan OAuth token para las Open APIs (Locations, Vessels, Commodities)
  // Devolvemos el Consumer Key como "token" para usarlo en las llamadas
  return MAERSK_KEY
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
    // Open APIs solo necesitan Consumer-Key en el header
    // Buscar por cityName filtrando solo terminales y puertos de Maersk
    // locationType=TERMINAL devuelve puertos marítimos operados por Maersk
    // Buscar por cityName sin filtro de tipo para máxima cobertura
    // El mínimo de limit según la spec es 10
    const params = new URLSearchParams({
      cityName: q,
      limit: '10'
    })
    const url = `https://api.maersk.com/reference-data/locations?${params}`
    const r = await fetch(url, {
      headers: {
        'Consumer-Key': MAERSK_KEY,
        'Accept': 'application/json'
      }
    })
    const rawText = await r.text()
    console.log('Maersk /ports status:', r.status)
    console.log('Maersk /ports raw:', rawText.slice(0, 500))
    
    let data
    try { data = JSON.parse(rawText) } catch(e) { data = [] }
    
    // La API puede devolver el array directamente o dentro de un objeto
    const list = Array.isArray(data) ? data 
      : Array.isArray(data?.locations) ? data.locations
      : Array.isArray(data?.data) ? data.data
      : []
    
    const ports = list.map(p => ({
      name:        p.cityName || p.locationName || '',
      code:        p.UNLocationCode || '',
      country:     p.countryCode || '',
      countryName: p.countryName || '',
      type:        p.locationType || '',
    })).filter(p => p.name)
    
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
// GET /schedules?from=ESVGO&to=PECLL — Rutas punto a punto Maersk DCSA
// ─────────────────────────────────────────────────────────────────────────────
function calcTransitDays(dep, arr) {
  if (!dep || !arr) return null
  try {
    const diff = new Date(arr) - new Date(dep)
    return Math.round(diff / (1000 * 60 * 60 * 24))
  } catch { return null }
}

app.get('/schedules', async (req, res) => {
  const { from, to, date } = req.query
  if (!from || !to) return res.status(400).json({ error: 'from y to son obligatorios' })

  try {
    const dateParam = date || new Date().toISOString().split('T')[0]
    const params = new URLSearchParams({
      placeOfReceipt:     from,
      placeOfDelivery:    to,
      departureStartDate: dateParam,
    })
    const url = `https://api.maersk.com/ocean/commercial-schedules/dcsa/v1/point-to-point-routes?${params}`
    console.log('Maersk /schedules:', url)

    const r = await fetch(url, {
      headers: { 'Consumer-Key': MAERSK_KEY, 'Accept': 'application/json' }
    })
    const rawText = await r.text()
    console.log('Maersk /schedules status:', r.status, rawText.slice(0, 200))

    let data
    try { data = JSON.parse(rawText) } catch(e) { data = [] }

    const routes = (Array.isArray(data) ? data : []).map(route => {
      const legs = route.legs || []
      const firstLeg = legs[0] || {}
      const lastLeg  = legs[legs.length - 1] || {}
      return {
        solutionNumber: route.solutionNumber,
        transhipments:  legs.length - 1,
        departure:      firstLeg.departureDateTime || '',
        arrival:        lastLeg.arrivalDateTime   || '',
        transitDays:    calcTransitDays(firstLeg.departureDateTime, lastLeg.arrivalDateTime),
        cutOffs:        (route.cutOffTimes || []).map(c => ({
          type: c.cutOffDateTimeCode,
          date: c.cutOffDateTime
        })),
        legs: legs.map(leg => ({
          vessel:    leg.vessel?.vesselName     || '',
          service:   leg.carrierServiceName     || leg.carrierServiceCode || '',
          voyage:    leg.carrierVoyageNumber    || '',
          pol:       leg.loadLocation?.UNLocationCode    || '',
          polName:   leg.loadLocation?.locationName      || '',
          pod:       leg.dischargeLocation?.UNLocationCode || '',
          podName:   leg.dischargeLocation?.locationName   || '',
          departure: leg.departureDateTime || '',
          arrival:   leg.arrivalDateTime   || '',
        }))
      }
    })

    res.json(routes)
  } catch (err) {
    console.error('Error /schedules:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ══════════════════════════════════════════════════════════════════════
// TRACKING ENDPOINT — añadir a tu servidor Railway (server.js / index.js)
// ══════════════════════════════════════════════════════════════════════
// Variables de entorno a añadir en Railway:
//   TRACKCARGO_API_KEY=tu_api_key_aqui
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY=eyJ...
// ══════════════════════════════════════════════════════════════════════


// Cliente Supabase con service key (bypass RLS, operaciones server-side)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)
function normalizeTrackCargo(raw, containerId) {
  const events = (raw.events || raw.milestones || []).map(e => ({
    event_time:  e.timestamp || e.date || e.event_time,
    location:    e.location?.name || e.location || e.port || '',
    status_code: e.status || e.event_code || e.milestone || '',
    description: e.description || e.event_description || '',
    vessel:      e.vessel?.name || e.vessel || '',
    voyage:      e.voyage || e.voyage_number || '',
  }))

  // Detecta el evento más reciente
  const latest = events[0] || {}

  return {
    container_id:   containerId.toUpperCase(),
    shipping_line:  raw.carrier || raw.shipping_line || raw.scac || '',
    current_status: raw.status || raw.shipment_status || latest.status_code || 'UNKNOWN',
    eta:            raw.eta || raw.estimated_arrival || null,
    pol:            raw.port_of_loading?.name || raw.pol || raw.origin || '',
    pod:            raw.port_of_discharge?.name || raw.pod || raw.destination || '',
    vessel:         raw.vessel?.name || raw.vessel || latest.vessel || '',
    voyage:         raw.voyage || raw.voyage_number || latest.voyage || '',
    provider_used:  'trackcargo',
    raw_payload:    raw,
    fetched_at:     new Date().toISOString(),
    events,
  }
}

// ── Guarda snapshot y eventos en Supabase ───────────────────────────
async function persistTracking(userId, normalized, expedienteId) {
  // Upsert snapshot (estado actual)
  const { error: snapError } = await supabase
    .from('tracking_snapshots')
    .upsert({
      user_id:        userId,
      container_id:   normalized.container_id,
      shipping_line:  normalized.shipping_line,
      current_status: normalized.current_status,
      eta:            normalized.eta,
      pol:            normalized.pol,
      pod:            normalized.pod,
      vessel:         normalized.vessel,
      voyage:         normalized.voyage,
      provider_used:  normalized.provider_used,
      raw_payload:    normalized.raw_payload,
      fetched_at:     normalized.fetched_at,
      expediente_id:  expedienteId || null,
    }, { onConflict: 'user_id,container_id' })

  if (snapError) console.error('[tracking] snapshot upsert error:', snapError.message)

  // Insert eventos nuevos (UNIQUE evita duplicados)
  if (normalized.events.length > 0) {
    const rows = normalized.events.map(e => ({
      user_id:      userId,
      container_id: normalized.container_id,
      event_time:   e.event_time,
      location:     e.location,
      status_code:  e.status_code,
      description:  e.description,
      vessel:       e.vessel,
      voyage:       e.voyage,
    }))

    const { error: evtError } = await supabase
      .from('tracking_events')
      .upsert(rows, { onConflict: 'user_id,container_id,event_time,status_code', ignoreDuplicates: true })

    if (evtError) console.error('[tracking] events upsert error:', evtError.message)
  }
}

// ══════════════════════════════════════════════════════════════════════
// ENDPOINTS — pegar estos app.get / app.post en tu server.js
// ══════════════════════════════════════════════════════════════════════

// GET /track/:container?userId=xxx&expedienteId=xxx
// Llama a TrackCargo, persiste en Supabase y devuelve resultado
app.get('/track/:container', async (req, res) => {
  const { container } = req.params
  const { userId, expedienteId } = req.query

  if (!container) return res.status(400).json({ error: 'container requerido' })
  if (!TRACKCARGO_KEY) return res.status(500).json({ error: 'TRACKCARGO_API_KEY no configurada' })

  try {
    // Llama a TrackCargo
    const tcRes = await fetch(`${TRACKCARGO_API}/track`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${TRACKCARGO_KEY}`,
        'X-API-Key':     TRACKCARGO_KEY,
      },
      body: JSON.stringify({ tracking_number: container.toUpperCase() }),
    })

    if (!tcRes.ok) {
      const err = await tcRes.text()
      return res.status(tcRes.status).json({ error: `TrackCargo error ${tcRes.status}: ${err}` })
    }

    const raw        = await tcRes.json()
    const normalized = normalizeTrackCargo(raw, container)

    // Persiste si tenemos userId
    if (userId) {
      await persistTracking(userId, normalized, expedienteId)
    }

    res.json(normalized)

  } catch (err) {
    console.error('[/track] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /track/:container/history?userId=xxx
// Devuelve el historial guardado en Supabase (sin llamar a TrackCargo)
app.get('/track/:container/history', async (req, res) => {
  const { container } = req.params
  const { userId }    = req.query

  if (!userId) return res.status(400).json({ error: 'userId requerido' })

  try {
    const { data, error } = await supabase
      .from('tracking_events')
      .select('*')
      .eq('user_id', userId)
      .eq('container_id', container.toUpperCase())
      .order('event_time', { ascending: false })
      .limit(50)

    if (error) throw new Error(error.message)
    res.json(data || [])

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /tracking/active?userId=xxx
// Lista todos los snapshots activos del usuario
app.get('/tracking/active', async (req, res) => {
  const { userId } = req.query
  if (!userId) return res.status(400).json({ error: 'userId requerido' })

  try {
    const { data, error } = await supabase
      .from('tracking_snapshots')
      .select(`
        *,
        expedientes(referencia, naviera, destino_nombre, eta)
      `)
      .eq('user_id', userId)
      .order('fetched_at', { ascending: false })

    if (error) throw new Error(error.message)
    res.json(data || [])

  } catch (err) {
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
