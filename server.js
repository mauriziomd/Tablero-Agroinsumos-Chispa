/**
 * Servidor del tablero de Agroinsumos Chispa.
 * ---------------------------------------------------------------
 * Qué hace:
 *  1. Cada cierto tiempo (CACHE_TTL_SECONDS) llama en segundo plano al
 *     Apps Script (que lee las 10 hojas y calcula todo) y guarda el
 *     resultado COMPLETO en memoria, sin límites de tamaño raros.
 *  2. Sirve el tablero (Tablero.html) y los datos (/api/data) desde
 *     ese caché en memoria — instantáneo para cualquier cantidad de
 *     gente que entre, sin volver a llamar a Apps Script cada vez.
 *  3. Protege todo con una clave de acceso (?key=... o pantalla de
 *     acceso) que es DISTINTA del secreto que usa para hablar con
 *     Apps Script (ese nadie más lo necesita saber).
 *
 * Variables de entorno que necesita (se configuran en Render, no aquí):
 *   GAS_URL              -> el link /exec de tu Apps Script
 *   GAS_SECRET           -> debe ser IGUAL al API_SECRET de Código.gs
 *   PUBLIC_KEY           -> la clave que vas a compartir con la gente
 *   CACHE_TTL_SECONDS    -> cada cuánto refrescar (por defecto 7200 = 2h)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GAS_URL = process.env.GAS_URL || '';
const GAS_SECRET = process.env.GAS_SECRET || '';
const PUBLIC_KEY = process.env.PUBLIC_KEY || 'Chispa2026';
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS) || 7200;

if (!GAS_URL || !GAS_SECRET) {
  console.warn('AVISO: falta configurar GAS_URL y/o GAS_SECRET (variables de entorno).');
}

// ---------------------------------------------------------------
// Caché en memoria
// ---------------------------------------------------------------
const cache = {
  data: null,       // el JSON (como texto) que se le sirve a los usuarios
  ts: 0,            // cuándo se calculó por última vez (Date.now())
  refreshing: false // evita refrescar dos veces al mismo tiempo
};

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCache() {
  if (cache.refreshing) return;
  if (!GAS_URL || !GAS_SECRET) return;
  cache.refreshing = true;
  const startedAt = Date.now();
  try {
    const url = GAS_URL + (GAS_URL.indexOf('?') === -1 ? '?' : '&') +
      'key=' + encodeURIComponent(GAS_SECRET);
    // Apps Script puede tardar bastante si tiene que recalcular todo
    // desde cero: le damos hasta 4 minutos antes de rendirnos.
    const resp = await fetchWithTimeout(url, 4 * 60 * 1000);
    const text = await resp.text();
    const parsed = JSON.parse(text); // valida que sea JSON de verdad
    if (parsed.error) throw new Error(parsed.error);

    cache.data = text;
    cache.ts = Date.now();
    console.log(
      '[' + new Date().toISOString() + '] Caché actualizado en ' +
      ((Date.now() - startedAt) / 1000).toFixed(1) + 's'
    );
  } catch (err) {
    console.error(
      '[' + new Date().toISOString() + '] No se pudo actualizar el caché: ' +
      (err && err.message ? err.message : err)
    );
    // Importante: si falla, se deja el caché anterior tal como estaba
    // (si existía), para no dejar a los usuarios sin nada.
  } finally {
    cache.refreshing = false;
  }
}

// Primer cálculo al arrancar el servidor, y luego cada CACHE_TTL_SECONDS
// en segundo plano (nadie tiene que esperar por esto, excepto la
// primerísima visita después de que el servidor arranca).
refreshCache();
setInterval(refreshCache, CACHE_TTL_SECONDS * 1000);

// ---------------------------------------------------------------
// Página de acceso (pide la clave)
// ---------------------------------------------------------------
function gatePage(showError) {
  const errorHtml = showError
    ? '<p style="color:#e2694a;font-size:13px;margin-top:14px">Clave incorrecta. Intenta de nuevo.</p>'
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agroinsumos Chispa — Acceso</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0f1720;
color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#182430;padding:36px 30px;border-radius:14px;max-width:340px;width:88%;
box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{font-size:19px;margin:0 0 6px}
p.sub{color:#8a97a3;font-size:13px;margin:0 0 22px;line-height:1.5}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:8px;
border:1px solid #2c3944;background:#0f1720;color:#fff;font-size:15px;margin-bottom:14px}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#2f7a4d;
color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#256240}
</style></head><body>
<div class="box"><h1>🌾 Agroinsumos Chispa</h1>
<p class="sub">Ingresa la clave de acceso para ver el tablero.</p>
<form method="get" action="/">
<input type="password" name="key" placeholder="Clave de acceso" autofocus required>
<button type="submit">Entrar</button>
</form>${errorHtml}
</div></body></html>`;
}

// Plantilla del tablero, leída una sola vez al arrancar.
const tableroTemplate = fs.readFileSync(path.join(__dirname, 'Tablero.html'), 'utf8');

// ---------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------

// Página principal: pide la clave, o muestra el tablero si ya la trae.
app.get('/', (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (key !== PUBLIC_KEY) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(gatePage(!!req.query.key));
  }
  const apiUrl = '/api/data?key=' + encodeURIComponent(PUBLIC_KEY);
  const html = tableroTemplate.replace('__API_URL__', apiUrl);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Datos del tablero (lo que usa el fetch() interno del HTML).
app.get('/api/data', async (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (key !== PUBLIC_KEY) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (!cache.data) {
    // Primera vez que se pide algo y todavía no hay nada calculado:
    // esperamos a que termine (puede tardar unos segundos).
    await refreshCache();
  }
  if (!cache.data) {
    return res.status(503).json({
      error: 'No se pudo obtener la información todavía. Intenta de nuevo en un momento.'
    });
  }
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.send(cache.data);
});

// Forzar un refresco manual sin esperar a que venza el caché.
// (Ábrelo en el navegador con tu clave: /refresh?key=TU_CLAVE)
app.get('/refresh', async (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (key !== PUBLIC_KEY) {
    return res.status(401).send('No autorizado');
  }
  await refreshCache();
  res.send(
    cache.data
      ? 'Caché actualizado correctamente (' + new Date(cache.ts).toLocaleString('es-VE') + ').'
      : 'No se pudo actualizar el caché. Revisa los "Logs" del servidor para ver el error.'
  );
});

// Estado simple, útil para revisar si todo está bien.
app.get('/status', (req, res) => {
  res.json({
    ok: !!cache.data,
    ultima_actualizacion: cache.ts ? new Date(cache.ts).toISOString() : null,
    edad_segundos: cache.ts ? Math.round((Date.now() - cache.ts) / 1000) : null,
    ttl_segundos: CACHE_TTL_SECONDS
  });
});

app.listen(PORT, () => {
  console.log('Servidor del tablero escuchando en el puerto ' + PORT);
});
