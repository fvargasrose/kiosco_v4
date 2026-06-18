#!/usr/bin/env bash
#
# gen_diagramas.sh — Genera diagramas del sistema DentalKiosco.
#
# Salidas en docs/diagramas/:
#   - *.mmd  : fuentes Mermaid (se ven en GitHub o en https://mermaid.live)
#   - *.svg  : render del mapa de módulos con Graphviz (si 'dot' está instalado)
#   - *.svg  : render de los Mermaid (sólo si 'mmdc' / mermaid-cli está instalado)
#
# Uso:
#   bash scripts/gen_diagramas.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/diagramas"
mkdir -p "$OUT"

echo "→ Generando diagramas en $OUT"

# ---------------------------------------------------------------------------
# 1. Arquitectura general (Mermaid)
# ---------------------------------------------------------------------------
cat > "$OUT/01_arquitectura.mmd" <<'EOF'
flowchart TB
    subgraph Cliente
        K[Kiosco / Navegador paciente]
        A[Panel Admin]
    end
    subgraph Borde
        CF[Cloudflare + Turnstile]
        CAD[Caddy 2 - TLS Let's Encrypt]
    end
    subgraph Backend
        API[API Fastify - Node 22]
        RL[Rate limit Redis]
        LIC[licenseMiddleware]
    end
    subgraph Datos
        PG[(PostgreSQL 16 - pgcrypto)]
        RD[(Redis 7)]
    end
    subgraph Externos
        DL[Dentalink API]
        WO[Wompi]
        SMS[LabsMobile / Twilio]
        MAIL[Resend / SMTP]
        LICSRV[License Server central]
    end

    K --> CF --> CAD --> API
    A --> CAD
    API --> RL
    API --> LIC
    API --> PG
    API --> RD
    API --> DL
    API --> WO
    API --> SMS
    API --> MAIL
    LIC -. heartbeat .-> LICSRV
    WO -. webhook firmado .-> API
EOF

# ---------------------------------------------------------------------------
# 2. Flujo de login con OTP (Mermaid - secuencia)
# ---------------------------------------------------------------------------
cat > "$OUT/02_flujo_login_otp.mmd" <<'EOF'
sequenceDiagram
    participant P as Paciente
    participant F as Frontend kiosco
    participant API as API
    participant DL as Dentalink
    participant SMS as SMS/Email
    P->>F: Ingresa cédula
    F->>API: POST /auth/request-otp (+ Turnstile en web)
    API->>DL: lookupPatientByCedula
    DL-->>API: datos paciente (+ celular)
    API->>API: genera OTP, guarda hash en otp_codes
    API->>SMS: envía código real
    SMS-->>P: SMS / Email con código
    P->>F: Ingresa código
    F->>API: POST /auth/verify-otp
    API->>API: verifica hash + expiración + intentos
    API-->>F: JWT sesión paciente (TTL 10 min)
EOF

# ---------------------------------------------------------------------------
# 3. Flujo de pago Wompi (Mermaid - secuencia)
# ---------------------------------------------------------------------------
cat > "$OUT/03_flujo_pago.mmd" <<'EOF'
sequenceDiagram
    participant P as Paciente
    participant API as API
    participant WO as Wompi
    participant REC as Reconciliador
    P->>API: POST /me/payments (saldo a pagar)
    API->>WO: crea transacción
    WO-->>API: referencia + QR
    API-->>P: muestra QR
    P->>WO: paga con app bancaria
    alt Webhook
        WO->>API: webhook (firma HMAC SHA256)
        API->>API: verifica firma -> marca APPROVED
    else Reconciliador (cron 1 min)
        REC->>WO: consulta estado de PENDING
        WO-->>REC: APPROVED / DECLINED
        REC->>API: actualiza transacción
    end
    API->>P: comprobante por email
EOF

# ---------------------------------------------------------------------------
# 4. Mapa de módulos (Graphviz)
# ---------------------------------------------------------------------------
cat > "$OUT/04_modulos.dot" <<'EOF'
digraph DentalKiosco {
    rankdir=LR;
    node [shape=box, style="rounded,filled", fontname="Helvetica", fillcolor="#eeeeff"];

    subgraph cluster_routes {
        label="Rutas (apps/api/src/routes)"; color="#8888aa";
        r_pauth[label="patient-auth"]; r_pme[label="patient-me"];
        r_pay[label="payments"]; r_book[label="booking"];
        r_kiosk[label="kiosk"]; r_aauth[label="admin-auth"];
        r_aclinic[label="admin-clinic"]; r_atx[label="admin-transactions"];
    }
    subgraph cluster_lib {
        label="Lib (apps/api/src/lib)"; color="#88aa88";
        l_jwt[label="jwt"]; l_otp[label="otp"]; l_totp[label="totp"];
        l_pwd[label="passwords (argon2id)"]; l_crypto[label="crypto (pgcrypto)"];
        l_dl[label="dentalink"]; l_wo[label="wompi"]; l_rec[label="reconciler"];
        l_sms[label="sms"]; l_mail[label="email"]; l_notif[label="notifications"];
        l_audit[label="audit"]; l_log[label="logger (redacción)"];
        l_amid[label="auth-middleware"]; l_pmid[label="patient-middleware"];
        l_lic[label="license/*"]; l_ts[label="turnstile"];
    }
    node [fillcolor="#ffeeee"];
    PG[label="PostgreSQL"]; RD[label="Redis"];

    r_pauth -> {l_otp l_dl l_notif l_ts l_jwt};
    r_pme -> {l_pmid l_dl l_jwt};
    r_pay -> {l_wo l_rec l_audit};
    r_book -> l_dl;
    r_kiosk -> l_jwt;
    r_aauth -> {l_pwd l_totp l_amid l_jwt l_audit};
    r_aclinic -> {l_crypto l_amid l_audit};
    r_atx -> {l_amid l_wo};

    l_otp -> RD; l_jwt -> RD; l_rec -> l_wo;
    l_crypto -> PG; l_audit -> PG; l_pwd -> PG;
    l_sms -> l_notif [dir=back]; l_mail -> l_notif [dir=back];
    l_lic -> RD;
}
EOF

echo "  ✓ Mermaid: 01_arquitectura.mmd, 02_flujo_login_otp.mmd, 03_flujo_pago.mmd"
echo "  ✓ Graphviz: 04_modulos.dot"

# ---------------------------------------------------------------------------
# Render opcional
# ---------------------------------------------------------------------------
if command -v dot >/dev/null 2>&1; then
    dot -Tsvg "$OUT/04_modulos.dot" -o "$OUT/04_modulos.svg"
    echo "  ✓ Render Graphviz → 04_modulos.svg"
else
    echo "  ⚠ 'dot' (graphviz) no instalado: instala con 'sudo apt install graphviz' para el SVG del mapa de módulos."
fi

MMDC=""
if command -v mmdc >/dev/null 2>&1; then
    MMDC="mmdc"
elif command -v npx >/dev/null 2>&1 && npx --no-install @mermaid-js/mermaid-cli -V >/dev/null 2>&1; then
    MMDC="npx --no-install @mermaid-js/mermaid-cli"
fi

if [ -n "$MMDC" ]; then
    for f in 01_arquitectura 02_flujo_login_otp 03_flujo_pago; do
        $MMDC -i "$OUT/$f.mmd" -o "$OUT/$f.svg" >/dev/null 2>&1 \
            && echo "  ✓ Render Mermaid → $f.svg"
    done
else
    echo "  ⚠ mermaid-cli no instalado: los .mmd se ven en https://mermaid.live o directamente en GitHub."
    echo "     (Opcional: 'pnpm add -g @mermaid-js/mermaid-cli' para render local a SVG.)"
fi

echo "→ Listo. Abre los archivos en $OUT"
