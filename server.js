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
const TRACKCARGO_KEY  = process.env.TRACKCARGO_API_KEY
const TRACKCARGO_API  = 'https://api.trackcargo.co/api/v1'

// ── Supabase — cliente lazy (se crea al primer uso, no al arrancar) ───────────
let _supabase = null
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key) throw new Error('SUPABASE_URL o SUPABASE_SERVICE_KEY no configuradas')
    _supabase = createClient(url, key)
  }
  return _supabase
}

// ── Cache de token Maersk ─────────────────────────────────────────────────────
let maerskToken = { value: null, expires: 0 }

async function getMaerskToken() {
  if (maerskToken.value && Date.now() < maerskToken.expires) {
    return maerskToken.value
  }
  return MAERSK_KEY
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — estado del servidor
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    service: 'FlexTec API',
    maersk:      MAERSK_KEY      ? 'configurado' : 'FALTA',
    anthropic:   ANTHROPIC_KEY   ? 'configurado' : 'FALTA',
    trackcargo:  TRACKCARGO_KEY  ? 'configurado' : 'FALTA',
    supabase:    process.env.SUPABASE_URL ? 'configurado' : 'FALTA',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /ports?q=vigo — Buscar puertos via Maersk Locations API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/ports', async (req, res) => {
  const { q = '', limit = 8 } = req.query
  if (q.length < 2) return res.json([])

  try {
    const params = new URLSearchParams({ cityName: q, limit: '10' })
    const url = `https://api.maersk.com/reference-data/locations?${params}`
    const r = await fetch(url, {
      headers: { 'Consumer-Key': MAERSK_KEY, 'Accept': 'application/json' }
    })
    const rawText = await r.text()
    console.log('Maersk /ports status:', r.status)

    let data
    try { data = JSON.parse(rawText) } catch(e) { data = [] }

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
// ─────────────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { messages, system, max_tokens = 8000, pdf } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages es obligatorio y debe ser un array' })
  }

  try {
    let finalMessages = [...messages]
    if (pdf?.b64) {
      const lastUser = finalMessages.filter(m => m.role === 'user').pop()
      if (lastUser) {
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
          vessel:    leg.vessel?.vesselName              || '',
          service:   leg.carrierServiceName              || leg.carrierServiceCode || '',
          voyage:    leg.carrierVoyageNumber             || '',
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

// ─────────────────────────────────────────────────────────────────────────────
// TRACKING — TrackCargo + Supabase
// ─────────────────────────────────────────────────────────────────────────────
function normalizeTrackCargo(raw, containerId) {
  const events = (raw.events || raw.milestones || []).map(e => ({
    event_time:  e.timestamp || e.date || e.event_time,
    location:    e.location?.name || e.location || e.port || '',
    status_code: e.status || e.event_code || e.milestone || '',
    description: e.description || e.event_description || '',
    vessel:      e.vessel?.name || e.vessel || '',
    voyage:      e.voyage || e.voyage_number || '',
  }))
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

async function persistTracking(userId, normalized, expedienteId) {
  const db = getSupabase()
  const { error: snapError } = await db
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

  if (snapError) console.error('[tracking] snapshot error:', snapError.message)

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
    const { error: evtError } = await db
      .from('tracking_events')
      .upsert(rows, { onConflict: 'user_id,container_id,event_time,status_code', ignoreDuplicates: true })
    if (evtError) console.error('[tracking] events error:', evtError.message)
  }
}

// GET /track/:container?userId=xxx&expedienteId=xxx
//
// Flujo TrackCargo (dos pasos):
//   1. POST /api/v1/client-orders/create/tracking/sea  → crea la orden, devuelve orderId
//   2. GET  /api/v1/client-orders/{orderId}/tracking   → consulta el tracking
//
app.get('/track/:container', async (req, res) => {
  const { container } = req.params
  const { userId, expedienteId } = req.query

  if (!container) return res.status(400).json({ error: 'container requerido' })
  if (!TRACKCARGO_KEY) return res.status(500).json({ error: 'TRACKCARGO_API_KEY no configurada' })

  const containerUC = container.toUpperCase()

  try {
    // ── PASO 1: Crear orden de tracking ──────────────────────────────────────
    // Probar con wrapper "data" anidado (típico en APIs que responden con data.success)
    const reqBody = {
      data: {
        trackingId:           containerUC,
        shipmentTrackingType: 'container',
      }
    }
    const createUrl = `${TRACKCARGO_API}/client-orders/create/tracking/sea`
    console.log('[/track] SENDING to:', createUrl, 'body:', JSON.stringify(reqBody))
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    TRACKCARGO_KEY,
      },
      body: JSON.stringify(reqBody),
    })
    const createText = await createRes.text()
    console.log('[/track] create status:', createRes.status, 'body:', createText.slice(0, 500))

    if (!createRes.ok) {
      return res.status(createRes.status).json({
        error: `TrackCargo create error ${createRes.status}: ${createText}`
      })
    }

    let createData
    try { createData = JSON.parse(createText) } catch { createData = {} }
    const orderId = createData.orderId || createData.order_id || createData.id || createData.data?.orderId

    if (!orderId) {
      return res.status(500).json({
        error: `TrackCargo no devolvió orderId. Respuesta: ${createText.slice(0, 300)}`
      })
    }

    // ── PASO 2: Consultar tracking ───────────────────────────────────────────
    const trackRes = await fetch(`${TRACKCARGO_API}/client-orders/${orderId}/tracking`, {
      method: 'GET',
      headers: { 'x-api-key': TRACKCARGO_KEY, 'Accept': 'application/json' },
    })
    const trackText = await trackRes.text()
    console.log('[/track] tracking status:', trackRes.status, 'body:', trackText.slice(0, 500))

    if (!trackRes.ok) {
      return res.status(trackRes.status).json({
        error: `TrackCargo tracking error ${trackRes.status}: ${trackText}`
      })
    }

    let raw
    try { raw = JSON.parse(trackText) } catch { raw = {} }
    const normalized = normalizeTrackCargo(raw, container)

    if (userId) await persistTracking(userId, normalized, expedienteId)

    res.json(normalized)

  } catch (err) {
    console.error('[/track] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /track/:container/history?userId=xxx
app.get('/track/:container/history', async (req, res) => {
  const { container } = req.params
  const { userId }    = req.query
  if (!userId) return res.status(400).json({ error: 'userId requerido' })

  try {
    const { data, error } = await getSupabase()
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
app.get('/tracking/active', async (req, res) => {
  const { userId } = req.query
  if (!userId) return res.status(400).json({ error: 'userId requerido' })

  try {
    const { data, error } = await getSupabase()
      .from('tracking_snapshots')
      .select(`*, expedientes(referencia, naviera, destino_nombre, eta)`)
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
  console.log(`   TRACKCARGO:    ${TRACKCARGO_KEY ? '✓' : '✗ FALTA'}`)
  console.log(`   SUPABASE:      ${process.env.SUPABASE_URL ? '✓' : '✗ FALTA'}`)
})
