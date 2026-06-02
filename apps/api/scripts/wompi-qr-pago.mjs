#!/usr/bin/env node
// =============================================================================
// Prueba de pago en Wompi (Colombia) — equivalente Node del script Python
// docs/wompi_qr_pago.py, con PARIDAD de funciones. 100% local e INDEPENDIENTE
// de la lógica de producción.
//
// NO importa wompi.ts ni config.ts; NO toca la BD ni el webhook ni el recibo al
// paciente/admin (eso es otra tarea). Lee las credenciales directamente de
// process.env (las mismas vars WOMPI_* que ya están en el .env del proyecto).
//
// CAMBIOS sobre el Python:
//   1. Monto de prueba FIJO: $5.000 COP (500000 centavos). Se ignora
//      WOMPI_AMOUNT_IN_CENTS para este fin (queda solo como referencia).
//   2. Logging doble: pantalla + archivo append apps/api/scripts/wompi-prueba.log
//      con timestamp ISO por línea. NUNCA escribe la llave privada (ni
//      enmascarada) ni datos de tarjeta; email/teléfono del pagador van
//      enmascarados.
//   3. El .env apunta a PRODUCCIÓN: advertencia clara + confirmación ('si')
//      antes de crear el link, para no disparar un cobro real por accidente.
//
// Modos:
//   node apps/api/scripts/wompi-qr-pago.mjs            # crea link + QR + polling
//   node apps/api/scripts/wompi-qr-pago.mjs --check <TX_ID>   # consulta puntual
//   node apps/api/scripts/wompi-qr-pago.mjs --dry-run  # NO llama a la API
//
// Requisitos: Node 22 (fetch nativo, process.loadEnvFile). Reusa `qrcode` de apps/api.
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import qrcode from 'qrcode';

// --------------------------------------------------------------------------- //
// Carga del .env (sin dotenv): process.loadEnvFile de Node 22.
// apps/api/scripts/ -> ../../../.env (raíz del repo). Si no existe, seguimos con
// el process.env presente (no es fatal).
// --------------------------------------------------------------------------- //
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.WOMPI_ENV_PATH || resolve(__dirname, '../../../.env');
try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // .env no encontrado o ya cargado por el entorno: usamos process.env tal cual.
}

// --------------------------------------------------------------------------- //
// Configuración — MISMAS vars que el script Python (ya están en .env)
// --------------------------------------------------------------------------- //
const PUB_KEY = (process.env.WOMPI_PUBLIC_KEY || '').trim();
const PRV_KEY = (process.env.WOMPI_PRIVATE_KEY || '').trim();
// production: https://production.wompi.co/v1 | sandbox: https://sandbox.wompi.co/v1
const BASE_URL = (process.env.WOMPI_BASE_URL || 'https://production.wompi.co/v1')
  .trim()
  .replace(/\/+$/, '');
const CHECKOUT_BASE = (process.env.WOMPI_CHECKOUT_BASE || 'https://checkout.wompi.co/l')
  .trim()
  .replace(/\/+$/, '');

// CAMBIO 1: monto de prueba FIJO = $5.000 COP. WOMPI_AMOUNT_IN_CENTS se conserva
// solo como referencia informativa; NO se usa para el cobro de esta prueba.
const TEST_AMOUNT_IN_CENTS = 500000; // $5.000 COP
const ENV_AMOUNT_REF = parseInt(process.env.WOMPI_AMOUNT_IN_CENTS || '0', 10) || null;

const POLL_INTERVAL = parseInt(process.env.WOMPI_POLL_INTERVAL || '4', 10); // segundos
const POLL_TIMEOUT = parseInt(process.env.WOMPI_POLL_TIMEOUT || '600', 10); // segundos (10 min)
const QR_PNG_PATH = process.env.WOMPI_QR_PATH || 'wompi_qr.png';

const FINAL_STATES = new Set(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR']);

// ¿Estamos contra producción? (llave o URL de prod)
const IS_PRODUCTION = BASE_URL.includes('production') || PRV_KEY.includes('prod');

// Archivo de log (append). Vive junto al script.
const LOG_PATH = resolve(__dirname, 'wompi-prueba.log');

// --------------------------------------------------------------------------- //
// Logging — pantalla + archivo (con timestamp ISO). Nunca datos sensibles.
// --------------------------------------------------------------------------- //
function fileLog(msg) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // si el log falla, no rompemos la prueba
  }
}
// log(): pantalla + archivo. Usar solo con texto NO sensible.
function log(msg) {
  console.log(msg);
  fileLog(msg);
}
function warn(msg) {
  console.warn(msg);
  fileLog(`[AVISO] ${msg}`);
}
// screen(): solo pantalla (para QR, dumps con llave enmascarada, progreso \r).
function screen(msg) {
  console.log(msg);
}

// --------------------------------------------------------------------------- //
// Utilidades
// --------------------------------------------------------------------------- //
function money(cents) {
  return `$${Math.round((cents ?? 0) / 100).toLocaleString('es-CO')} COP`;
}

function die(msg, code = 1) {
  console.error(`\n[ERROR] ${msg}\n`);
  fileLog(`[ERROR] ${msg}`);
  process.exit(code);
}

// Solo para PANTALLA. La llave privada jamás se escribe al archivo de log.
function maskKey(key) {
  if (!key) return '(vacío)';
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)} (len ${key.length})`;
}

function maskEmail(email) {
  if (!email || !String(email).includes('@')) return '[oculto]';
  const [local, domain] = String(email).split('@');
  if (!local || !domain) return '[oculto]';
  const visible = local.length > 2 ? local.slice(0, 2) : local[0];
  return `${visible}***@${domain}`;
}

function maskPhone(phone) {
  const p = String(phone ?? '');
  if (p.length < 8) return '[oculto]';
  return p.slice(0, 3) + '****' + p.slice(-2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkConfig() {
  if (!PRV_KEY || !PUB_KEY) {
    die('Faltan WOMPI_PUBLIC_KEY o WOMPI_PRIVATE_KEY en el .env');
  }
  if (!PRV_KEY.startsWith('prv_')) {
    warn("La llave privada no empieza por 'prv_'. Verifica el .env.");
  }
  if (!PUB_KEY.startsWith('pub_')) {
    warn("La llave pública no empieza por 'pub_'. Verifica el .env.");
  }
  if (PRV_KEY.includes('prod')) {
    warn('Estás usando llaves de PRODUCCIÓN: el cobro será REAL.');
  }
}

// Body del POST /payment_links (paridad con el Python). Aislado para poder
// inspeccionarlo en --dry-run sin llamar a la API. Usa el monto FIJO de prueba.
function buildPaymentLinkBody() {
  return {
    name: 'Prueba de pago',
    description: `Pago de prueba Wompi (${money(TEST_AMOUNT_IN_CENTS)})`,
    single_use: true, // se cierra tras el primer pago APROBADO
    collect_shipping: false,
    currency: 'COP',
    amount_in_cents: TEST_AMOUNT_IN_CENTS,
  };
}

function printConfig() {
  // SOLO pantalla: incluye la llave privada enmascarada (no va al archivo).
  screen('Variables WOMPI_* leídas del .env:');
  screen(`  WOMPI_ENV_PATH (usado)   : ${ENV_PATH}`);
  screen(`  WOMPI_PUBLIC_KEY         : ${maskKey(PUB_KEY)}`);
  screen(`  WOMPI_PRIVATE_KEY        : ${maskKey(PRV_KEY)}  (NO se escribe al log)`);
  screen(`  WOMPI_BASE_URL           : ${BASE_URL}`);
  screen(`  WOMPI_CHECKOUT_BASE      : ${CHECKOUT_BASE}`);
  screen(`  WOMPI_AMOUNT_IN_CENTS    : ${ENV_AMOUNT_REF ?? '(no definido)'}  (IGNORADO; referencia)`);
  screen(`  Monto de la prueba (fijo): ${TEST_AMOUNT_IN_CENTS} (${money(TEST_AMOUNT_IN_CENTS)})`);
  screen(`  WOMPI_POLL_INTERVAL      : ${POLL_INTERVAL}s`);
  screen(`  WOMPI_POLL_TIMEOUT       : ${POLL_TIMEOUT}s`);
  screen(`  WOMPI_QR_PATH            : ${QR_PNG_PATH}`);
}

// --------------------------------------------------------------------------- //
// API Wompi (fetch nativo de Node 22)
// --------------------------------------------------------------------------- //
async function createPaymentLink() {
  const url = `${BASE_URL}/payment_links`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PRV_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildPaymentLinkBody()),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200 && res.status !== 201) {
    const text = await res.text().catch(() => '');
    die(`No se pudo crear el link de pago (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.data ?? {};
}

// El GET del link no requiere autenticación. Nunca lanza: ante cualquier fallo
// de red/JSON devuelve {} para que el loop de polling no se caiga.
async function getPaymentLink(linkId) {
  try {
    const res = await fetch(`${BASE_URL}/payment_links/${linkId}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) return {};
    const json = await res.json();
    return json.data ?? {};
  } catch (e) {
    process.stdout.write(`  [red] aviso al consultar el link: ${e.message ?? e}\r`);
    return {};
  }
}

// La consulta de transacción se puede hacer con la llave pública.
async function getTransaction(txId) {
  try {
    const res = await fetch(`${BASE_URL}/transactions/${txId}`, {
      headers: { Authorization: `Bearer ${PUB_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) return {};
    const json = await res.json();
    return json.data ?? {};
  } catch (e) {
    process.stdout.write(`  [red] aviso al consultar la transacción: ${e.message ?? e}\r`);
    return {};
  }
}

// Busca el arreglo de transacciones en la respuesta del link. Wompi no documenta
// con claridad esta clave para links, así que probamos varias ubicaciones
// posibles antes de rendirnos (mismos 3 fallbacks que el Python).
function extractTransactions(linkData) {
  if (!linkData || typeof linkData !== 'object') return [];
  for (const key of ['transactions', 'payment_transactions']) {
    const val = linkData[key];
    if (Array.isArray(val)) return val;
  }
  const meta = linkData.meta;
  if (meta && typeof meta === 'object' && Array.isArray(meta.transactions)) {
    return meta.transactions;
  }
  return [];
}

// Loguea datos del pagador SOLO enmascarados, si Wompi los devuelve.
function logPayerMasked(data) {
  const email = data?.customer_email;
  const phone = data?.customer_data?.phone_number ?? data?.phone_number;
  if (email) log(`  Pagador email: ${maskEmail(email)}`);
  if (phone) log(`  Pagador tel:   ${maskPhone(phone)}`);
}

// --------------------------------------------------------------------------- //
// QR
// --------------------------------------------------------------------------- //
async function showQrTerminal(url) {
  const ascii = await qrcode.toString(url, { type: 'terminal', small: true });
  screen('\n' + ascii + '\n'); // el QR va solo a pantalla (no al log)
  fileLog('[QR] Código QR del checkout mostrado en terminal');
}

async function saveQrPng(url, path) {
  try {
    await qrcode.toFile(path, url);
    log(`[QR] Imagen guardada en: ${resolve(path)}`);
  } catch (e) {
    warn(`No se pudo guardar el PNG del QR: ${e.message ?? e}`);
  }
}

// --------------------------------------------------------------------------- //
// Polling
// --------------------------------------------------------------------------- //
function statusIcon(status) {
  return { APPROVED: '✅', DECLINED: '❌', VOIDED: '↩️', ERROR: '⚠️', PENDING: '⏳' }[status] ?? '•';
}
function reportStatus(txId, status) {
  screen(`  ${statusIcon(status)} Transacción ${txId}: ${status}`);
}

async function pollLink(linkId) {
  log(`[POLLING] Esperando el pago (cada ${POLL_INTERVAL}s, máx ${POLL_TIMEOUT}s)...`);
  screen('          Pulsa Ctrl+C para detener.\n');
  const start = Date.now();
  const seenStatus = new Map(); // tx_id -> último status mostrado
  let diagnosed = false;

  while (Date.now() - start < POLL_TIMEOUT * 1000) {
    try {
      const linkData = await getPaymentLink(linkId);

      // Diagnóstico una sola vez: qué campos devuelve realmente el link.
      if (!diagnosed && linkData && Object.keys(linkData).length > 0) {
        const claves = Object.keys(linkData).sort().join(', ');
        screen(`\n[DIAG] El GET del link devuelve estos campos: ${claves}`);
        if (extractTransactions(linkData).length === 0) {
          screen('[DIAG] No incluye un arreglo de transacciones; en tu cuenta');
          screen('       este endpoint NO sirve para detectar el pago.');
          screen('       Usa el webhook, o confirma con --check <TX_ID>.\n');
        }
        diagnosed = true;
      }

      const txs = extractTransactions(linkData);
      for (const tx of txs) {
        const txId = tx.id;
        let status = tx.status;
        let full = tx;
        if (txId && !status) {
          full = await getTransaction(txId);
          status = full.status;
        }
        if (!txId || !status) continue;

        if (seenStatus.get(txId) !== status) {
          reportStatus(txId, status);
          fileLog(`Cambio de estado tx=${txId} status=${status}`);
          logPayerMasked(full);
          seenStatus.set(txId, status);
        }

        if (FINAL_STATES.has(status)) {
          const ref = full.reference ?? tx.reference ?? '(sin referencia)';
          const amount = full.amount_in_cents ?? tx.amount_in_cents ?? TEST_AMOUNT_IN_CENTS;
          if (status === 'APPROVED') {
            log(`\n🎉 ¡Pago APROBADO! Transacción ${txId} por ${money(amount)}.`);
          } else {
            log(`\nTransacción ${txId} finalizó con estado: ${status}`);
          }
          log(`Estado FINAL tx=${txId} status=${status} ref=${ref} monto=${money(amount)}`);
          return status;
        }
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`  ... sin pago aún (${elapsed}s)        \r`);
      await sleep(POLL_INTERVAL * 1000);
    } catch (e) {
      // Nada debe tumbar el loop: lo reportamos y seguimos.
      warn(`iteración con error, reintentando: ${e.message ?? e}`);
      await sleep(POLL_INTERVAL * 1000);
    }
  }

  log('\n[TIMEOUT] No se detectó un pago dentro del tiempo límite.');
  screen('Si pagaste, confirma la transacción con su id:');
  screen('  node apps/api/scripts/wompi-qr-pago.mjs --check <TRANSACTION_ID>');
  return null;
}

async function checkSingleTransaction(txId) {
  const data = await getTransaction(txId);
  if (!data || Object.keys(data).length === 0) {
    die(`No se encontró la transacción ${txId} (revisa el id y la llave pública).`);
  }
  const status = data.status ?? 'DESCONOCIDO';
  const ref = data.reference ?? '(sin referencia)';
  reportStatus(txId, status);
  logPayerMasked(data);
  if (data.amount_in_cents != null) {
    screen(`  Monto: ${money(data.amount_in_cents)}`);
  }
  log(
    `Estado FINAL tx=${txId} status=${status} ref=${ref} monto=${
      data.amount_in_cents != null ? money(data.amount_in_cents) : '(desconocido)'
    }`,
  );
  if (status === 'APPROVED') {
    screen('\n🎉 Pago APROBADO.\n');
  }
  return status;
}

// --------------------------------------------------------------------------- //
// Confirmación anti-cobro-accidental (producción)
// --------------------------------------------------------------------------- //
async function confirmRealCharge() {
  const banner = `ATENCIÓN: ambiente ${IS_PRODUCTION ? 'PRODUCCIÓN' : BASE_URL}, este cobro es REAL por ${money(
    TEST_AMOUNT_IN_CENTS,
  )}`;
  screen('\n' + '!'.repeat(64));
  log(banner);
  screen('!'.repeat(64));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question("\nEscribe 'si' para crear el link y generar el cobro REAL: ", res),
  );
  rl.close();
  if (answer.trim().toLowerCase() !== 'si') {
    log('Operación cancelada por el usuario (no se creó ningún link, no hubo cobro).');
    process.exit(0);
  }
  fileLog('Confirmación recibida: el usuario autorizó crear el link de cobro REAL.');
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //
async function main() {
  const argv = process.argv.slice(2);

  // Modo: confirmar una transacción puntual (solo lectura, no cobra).
  if (argv[0] === '--check' && argv[1]) {
    checkConfig();
    fileLog(`=== --check tx=${argv[1].trim()} ===`);
    await checkSingleTransaction(argv[1].trim());
    return;
  }

  // Modo: dry-run — NO llama a la API. Imprime config y el body; escribe una
  // línea de prueba en el log.
  if (argv[0] === '--dry-run') {
    screen('='.repeat(60));
    screen('  WOMPI — DRY RUN (no se llama a la API, no se crea ningún link)');
    screen('='.repeat(60) + '\n');
    printConfig();
    screen('\nBody que se enviaría a POST ' + `${BASE_URL}/payment_links` + ':');
    screen(JSON.stringify(buildPaymentLinkBody(), null, 2));
    screen('\nValidación de credenciales (no fatal en dry-run):');
    screen(`  privada empieza por 'prv_': ${PRV_KEY.startsWith('prv_')}`);
    screen(`  pública empieza por 'pub_': ${PUB_KEY.startsWith('pub_')}`);
    fileLog(
      `[DRY-RUN] Construcción de body OK (no se llamó a la API, no se creó link). ` +
        `Monto=${money(TEST_AMOUNT_IN_CENTS)} ambiente=${BASE_URL}`,
    );
    return;
  }

  // Modo real: crea link + QR + polling. Con confirmación anti-accidente.
  checkConfig();
  fileLog('=== Inicio prueba de pago Wompi ===');
  log(`Ambiente: ${BASE_URL}`);
  log(`Monto: ${money(TEST_AMOUNT_IN_CENTS)}`);

  screen('='.repeat(60));
  screen('  PRUEBA DE PAGO WOMPI');
  screen(`  Ambiente : ${BASE_URL}`);
  screen(`  Monto    : ${money(TEST_AMOUNT_IN_CENTS)}`);
  screen('='.repeat(60));

  await confirmRealCharge();

  const link = await createPaymentLink();
  const linkId = link.id;
  if (!linkId) {
    die(`La respuesta no trae el id del link: ${JSON.stringify(link)}`);
  }

  const checkoutUrl = `${CHECKOUT_BASE}/${linkId}`;
  log(`[OK] Link de pago creado: ${linkId}`);
  log(`     URL de checkout: ${checkoutUrl}`);

  await showQrTerminal(checkoutUrl);
  await saveQrPng(checkoutUrl, QR_PNG_PATH);

  screen('Escanea el QR con tu celular (o abre la URL) y completa el pago.');

  try {
    await pollLink(linkId);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    warn(`Polling detenido: ${e?.message ?? e}`);
  }
}

// --------------------------------------------------------------------------- //
// Arranque: solo si se ejecuta directo (no al importarse para test).
// --------------------------------------------------------------------------- //
const thisFile = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === thisFile;
if (isMain) {
  main().catch((e) => die(e?.stack ?? e?.message ?? String(e)));
}

// Exportado para pruebas (mock de fetch). No se ejecuta nada al importar.
export {
  money,
  maskEmail,
  maskPhone,
  buildPaymentLinkBody,
  extractTransactions,
  reportStatus,
  getTransaction,
  checkSingleTransaction,
  TEST_AMOUNT_IN_CENTS,
  LOG_PATH,
};
