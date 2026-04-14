# FlexTec API Server

Servidor Node.js que actúa como proxy seguro para FlexTec.
Guarda las credenciales de Anthropic y Maersk en el servidor,
nunca en el navegador del cliente.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /health | Estado del servidor |
| GET | /ports?q=vigo | Buscar puertos (Maersk) |
| POST | /chat | Chat con Claude (Anthropic) |

## Deploy en Railway (paso a paso)

1. Subir esta carpeta a GitHub como repo nuevo (ej. `flextec-api`)
2. Entrar en railway.app → New Project → Deploy from GitHub repo
3. Seleccionar el repo `flextec-api`
4. Railway detecta automáticamente que es Node.js
5. Ir a Settings → Variables y añadir:
   - ANTHROPIC_KEY = tu API key de Anthropic
   - MAERSK_KEY = p77GXozTmD6HlRYUhbwVpjGX7LZjHauC
   - MAERSK_SECRET = RH12oa3Rq1uNzgK8
6. Railway te da una URL pública → copiarla para FlexTec

## Desarrollo local

```bash
npm install
cp .env.example .env
# Editar .env con tus keys reales
node server.js
# → Servidor corriendo en http://localhost:3001
```
