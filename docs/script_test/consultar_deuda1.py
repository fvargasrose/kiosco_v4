
#!/usr/bin/env python3
"""
🦷 Dentalink - Consulta Financiera de Paciente
===============================================
Consulta el estado financiero/deudas de un paciente por:
  - ID interno Dentalink
  - Cédula / RUT
  - Teléfono / Celular

Uso:
    python consultar_financiero.py
    python consultar_financiero.py --id 4179
    python consultar_financiero.py --cedula 12345678
    python consultar_financiero.py --telefono 3001234567

Requisitos:
    pip install requests
"""

import requests
import json
import argparse
from datetime import datetime

# ══════════════════════════════════════════════════════════════
# CONFIGURACIÓN  (editar aquí o usar variables de entorno)
# ══════════════════════════════════════════════════════════════

import os

API_BASE = os.environ.get("DENTALINK_API_BASE", "https://api.dentalink.healthatom.com/api/v1")
TOKEN    = os.environ.get("DENTALINK_TOKEN", "7en0PKvpr1xzsMZ5hlomiV6VZim0bj8FYOd11rM1.D0vRjguLK94a7l1XVInwAiClbDdbSr4Wyigbl99o")

# ── Paciente por defecto cuando no se pasan argumentos ────────
DEFAULT_ID = 4179   # ← cambia aquí para otro paciente fijo

# ══════════════════════════════════════════════════════════════
# UTILIDADES
# ══════════════════════════════════════════════════════════════

def headers():
    return {"Authorization": f"Token {TOKEN}", "Content-Type": "application/json"}


def get(endpoint, params=None):
    url = f"{API_BASE}{endpoint}"
    try:
        r = requests.get(url, headers=headers(), params=params, timeout=15)
        return r, None
    except requests.exceptions.RequestException as e:
        return None, str(e)


def sep(titulo="", emoji="─", ancho=65):
    if titulo:
        print(f"\n{'═' * ancho}")
        print(f"   {emoji}  {titulo}")
        print(f"{'═' * ancho}")
    else:
        print(f"   {'─' * (ancho - 3)}")


# ══════════════════════════════════════════════════════════════
# BÚSQUEDA DE PACIENTE
# ══════════════════════════════════════════════════════════════

def buscar_por_id(id_paciente: int):
    """Obtiene el paciente directamente por su ID interno."""
    r, err = get(f"/pacientes/{id_paciente}")
    if err:
        return None, f"Error de conexión: {err}"
    if r.status_code == 200:
        data = r.json().get("data")
        # Algunos endpoints devuelven lista, otros objeto directo
        if isinstance(data, list):
            return (data[0] if data else None), None
        return data, None
    return None, f"HTTP {r.status_code}: {r.text[:120]}"


def buscar_por_campo(campo: str, valor: str):
    """
    Busca paciente filtrando por 'rut' (cédula) o 'celular' (teléfono).
    campo: 'rut' | 'celular'
    """
    q = json.dumps({campo: {"eq": valor}})
    r, err = get("/pacientes", params={"q": q})
    if err:
        return None, f"Error de conexión: {err}"
    if r.status_code == 200:
        data = r.json().get("data", [])
        if data:
            return data[0], None
        return None, f"No se encontró paciente con {campo}='{valor}'"
    return None, f"HTTP {r.status_code}: {r.text[:120]}"


# ══════════════════════════════════════════════════════════════
# DATOS FINANCIEROS
# ══════════════════════════════════════════════════════════════

def obtener_tratamientos(id_paciente):
    r, err = get(f"/pacientes/{id_paciente}/tratamientos")
    if err or r.status_code != 200:
        return []
    return r.json().get("data", [])


def obtener_citas(id_paciente):
    r, err = get(f"/pacientes/{id_paciente}/citas")
    if err or r.status_code != 200:
        return []
    return r.json().get("data", [])


def obtener_pagos(id_paciente):
    """Prueba varios endpoints de pagos/abonos."""
    for ep in [f"/pacientes/{id_paciente}/pagos",
               f"/pacientes/{id_paciente}/recaudacion",
               f"/pacientes/{id_paciente}/abonos"]:
        r, err = get(ep)
        if r and r.status_code == 200:
            return r.json().get("data", []), ep
    return [], None


# ══════════════════════════════════════════════════════════════
# MOSTRAR REPORTE
# ══════════════════════════════════════════════════════════════

def mostrar_reporte(paciente: dict):
    id_p     = paciente.get("id")
    nombre   = paciente.get("nombre", "")
    apellido = paciente.get("apellidos", "")
    cedula   = paciente.get("rut", "N/A")
    celular  = paciente.get("celular", "N/A")
    email    = paciente.get("email", "N/A")

    sep(f"PACIENTE: {nombre} {apellido}", "👤")
    print(f"   ID Dentalink : {id_p}")
    print(f"   Cédula / RUT : {cedula}")
    print(f"   Celular      : {celular}")
    print(f"   Email        : {email}")

    # ── Tratamientos ──────────────────────────────────────────
    tratamientos = obtener_tratamientos(id_p)
    total_ppto = total_abo = total_deuda = 0.0

    sep("TRATAMIENTOS", "📋")
    if tratamientos:
        print(f"   {'ID':<6} {'Nombre':<28} {'Total':>12} {'Abonado':>12} {'Deuda':>12}")
        print(f"   {'─'*6} {'─'*28} {'─'*12} {'─'*12} {'─'*12}")
        for t in tratamientos:
            tid   = t.get("id", "")
            tnom  = str(t.get("nombre", "Sin nombre"))[:27]
            tt    = float(t.get("total",   0) or 0)
            ta    = float(t.get("abonado", 0) or 0)
            td    = float(t.get("deuda",   0) or 0)
            total_ppto  += tt
            total_abo   += ta
            total_deuda += td
            marca = "🔴" if td > 0 else "✅"
            print(f"   {tid:<6} {tnom:<28} ${tt:>10,.0f} ${ta:>10,.0f} ${td:>10,.0f} {marca}")
        print(f"   {'─'*6} {'─'*28} {'─'*12} {'─'*12} {'─'*12}")
        print(f"   {'TOTAL':<35} ${total_ppto:>10,.0f} ${total_abo:>10,.0f} ${total_deuda:>10,.0f}")
    else:
        print("   Sin tratamientos registrados.")

    # ── Citas ─────────────────────────────────────────────────
    citas = obtener_citas(id_p)
    sep("CITAS", "📅")
    if citas:
        hoy = datetime.now().strftime("%Y-%m-%d")
        futuras  = [c for c in citas if c.get("fecha", "") >= hoy]
        pasadas  = len(citas) - len(futuras)
        print(f"   Total: {len(citas)}  |  Pasadas: {pasadas}  |  Futuras: {len(futuras)}")
        print()
        for c in sorted(citas, key=lambda x: x.get("fecha", ""), reverse=True)[:5]:
            fecha  = c.get("fecha", "")
            hora   = c.get("hora_inicio", "")
            estado = c.get("estado_cita", c.get("estado", ""))
            icono  = "🔜" if fecha >= hoy else "◽"
            print(f"   {icono} {fecha}  {hora}  —  {estado}")
    else:
        print("   Sin citas registradas.")

    # ── Pagos ─────────────────────────────────────────────────
    pagos, ep_pagos = obtener_pagos(id_p)
    if pagos:
        sep(f"PAGOS  [{ep_pagos}]", "💳")
        for p in pagos[:10]:
            print(f"   • {p}")

    # ── Resumen financiero ────────────────────────────────────
    sep("RESUMEN FINANCIERO", "💰")
    print(f"   Presupuestado  : ${total_ppto:>15,.0f}")
    print(f"   Abonado        : ${total_abo:>15,.0f}")
    if total_deuda > 0:
        print(f"   DEUDA PENDIENTE: ${total_deuda:>15,.0f}  🔴")
    else:
        print(f"   DEUDA PENDIENTE: ${total_deuda:>15,.0f}  ✅ Al día")

    print()


# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════

def parse_args():
    p = argparse.ArgumentParser(description="Consulta financiera Dentalink")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--id",       type=int,   help="ID interno Dentalink")
    g.add_argument("--cedula",   type=str,   help="Cédula / RUT del paciente")
    g.add_argument("--telefono", type=str,   help="Teléfono / celular del paciente")
    return p.parse_args()


def main():
    args = parse_args()

    print("\n╔" + "═" * 63 + "╗")
    print("║" + "   🦷  DENTALINK — CONSULTA FINANCIERA DE PACIENTE".center(63) + "║")
    print("╚" + "═" * 63 + "╝")
    print(f"   Fecha : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"   API   : {API_BASE}")

    # ── Determinar modo de búsqueda ───────────────────────────
    paciente = None
    error    = None

    if args.cedula:
        print(f"\n   🔍 Buscando por cédula: {args.cedula}")
        paciente, error = buscar_por_campo("rut", args.cedula)

    elif args.telefono:
        print(f"\n   🔍 Buscando por teléfono: {args.telefono}")
        paciente, error = buscar_por_campo("celular", args.telefono)

    else:
        # --id explícito o DEFAULT_ID
        id_buscar = args.id if args.id else DEFAULT_ID
        print(f"\n   🔍 Buscando por ID: {id_buscar}")
        paciente, error = buscar_por_id(id_buscar)

    # ── Resultado ─────────────────────────────────────────────
    if error:
        print(f"\n   ✗ {error}\n")
        return

    if not paciente:
        print("\n   ⚠️  Paciente no encontrado.\n")
        return

    mostrar_reporte(paciente)


if __name__ == "__main__":
    main()
