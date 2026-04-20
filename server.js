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
function normalizeTrackCargo(raw, containerId, scacCode) {
  // TrackCargo responde con { data: { trackingData: {...}, status }, dataDescription }
  const tracking = raw?.data?.trackingData || raw?.trackingData || {}
  const legs     = Array.isArray(tracking.legs) ? tracking.legs : []
  const firstLeg = legs[0] || {}
  const lastLeg  = legs[legs.length - 1] || firstLeg

  const now    = Date.now()
  const tStart = l => (l?.leg_start_utc ? new Date(l.leg_start_utc).getTime() : null)
  const tEnd   = l => (l?.leg_end_utc   ? new Date(l.leg_end_utc).getTime()   : null)

  // Leg activo: aquel cuya ventana [start, end] contiene "now".
  // Si no hay, el primero cuyo end esté en el futuro; si no, el último leg.
  let activeLeg = legs.find(l => { const s=tStart(l), e=tEnd(l); return s && e && s <= now && e >= now })
  if (!activeLeg) activeLeg = legs.find(l => { const e=tEnd(l); return e && e >= now }) || lastLeg

  const fmtPort = p => {
    if (!p) return ''
    const base = p.city || p.unloc || ''
    const cc   = p.country?.country_code
    return cc && base ? `${base}, ${cc}` : base
  }

  // ETD global = salida del primer leg. ETA global = llegada del último leg.
  const eta = tracking.last_pod_eta_iso?.date || tracking.first_pod_eta_iso?.date || lastLeg.leg_end_utc  || null
  const etd = tracking.first_pol_etd_iso?.date || firstLeg.leg_start_utc                                   || null

  // Status derivado del timeline
  let currentStatus = 'UNKNOWN'
  const lastEnd    = tEnd(lastLeg)
  const firstStart = tStart(firstLeg)
  if (lastEnd && lastEnd < now)            currentStatus = 'ARRIVED'
  else if (activeLeg && tStart(activeLeg) && tStart(activeLeg) <= now) currentStatus = 'IN_TRANSIT'
  else if (firstStart && firstStart > now) currentStatus = 'LOADED'
  else if (legs.length > 0)                currentStatus = 'IN_TRANSIT'

  // Sintetizar eventos desde los legs (TrackCargo nunca devuelve events discretos).
  const events = []
  legs.forEach(leg => {
    const pFrom = fmtPort(leg.port_from)
    const pTo   = fmtPort(leg.port_to)
    if (leg.leg_start_utc) {
      const past = new Date(leg.leg_start_utc).getTime() < now
      events.push({
        event_time:  leg.leg_start_utc,
        location:    pFrom,
        status_code: past ? 'DEPARTED' : 'ETD',
        description: past ? `Salida de ${pFrom || '—'}` : `ETD ${pFrom || '—'}`,
        vessel:      leg.vessel_name || '',
        voyage:      leg.voyage_no   || '',
      })
    }
    if (leg.leg_end_utc) {
      const past = new Date(leg.leg_end_utc).getTime() < now
      events.push({
        event_time:  leg.leg_end_utc,
        location:    pTo,
        status_code: past ? 'ARRIVED' : 'ETA',
        description: past ? `Llegada a ${pTo || '—'}` : `ETA ${pTo || '—'}`,
        vessel:      leg.vessel_name || '',
        voyage:      leg.voyage_no   || '',
      })
    }
  })
  events.sort((a, b) => new Date(b.event_time) - new Date(a.event_time))

  const shippingLine =
       tracking.carrier_name
    || tracking.carrier?.name
    || raw?.data?.carrier_name
    || (scacCode || '')

  return {
    container_id:   containerId.toUpperCase(),
    shipping_line:  shippingLine,
    current_status: currentStatus,
    eta,
    etd,
    pol:            fmtPort(firstLeg.port_from),
    pod:            fmtPort(lastLeg.port_to),
    vessel:         activeLeg?.vessel_name || lastLeg.vessel_name || '',
    voyage:         activeLeg?.voyage_no   || lastLeg.voyage_no   || '',
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
  const { userId, expedienteId, scac } = req.query

  if (!container) return res.status(400).json({ error: 'container requerido' })
  if (!TRACKCARGO_KEY) return res.status(500).json({ error: 'TRACKCARGO_API_KEY no configurada' })

  const containerUC = container.toUpperCase()
  // scacCode es obligatorio por el schema de TrackCargo. Acepta el query param ?scac=XXXX, si no usa MAEU por defecto.
  const scacCode = (scac || 'MAEU').toUpperCase()

  try {
    // ── PASO 1: Crear orden de tracking ──────────────────────────────────────
    // Estructura correcta según OpenAPI de TrackCargo (SeaShipmentOrderDtoV2):
    // campos obligatorios: trackingId, seaShipmentTrackingType, scacCode
    const reqBody = {
      trackingId:              containerUC,
      seaShipmentTrackingType: 'container',
      scacCode:                scacCode,
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
    let orderId = createData.orderId || createData.order_id || createData.id || createData.data?.orderId

    // Si TrackCargo dice "already exists" (refresh de un contenedor ya trackeado),
    // buscamos el orderId en /client-orders/recent por su trackingId.
    if (!orderId) {
      const errMsg = createData.error?.errorMessage || ''
      if (/already exists/i.test(errMsg)) {
        console.log('[/track] Order already exists, buscando en /recent ...')
        const recentRes = await fetch(`${TRACKCARGO_API}/client-orders/recent`, {
          headers: { 'x-api-key': TRACKCARGO_KEY, 'Accept': 'application/json' },
        })
        const recentText = await recentRes.text()
        let recentData
        try { recentData = JSON.parse(recentText) } catch { recentData = {} }
        const list = recentData.data || recentData || []
        const match = Array.isArray(list) ? list.find(o => (o.tracking_id || '').toUpperCase() === containerUC) : null
        if (match?.orderId) {
          orderId = match.orderId
          console.log('[/track] Encontrado orderId existente:', orderId)
        }
      }
    }

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
    const normalized = normalizeTrackCargo(raw, container, scacCode)

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
