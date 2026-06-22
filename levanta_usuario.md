# Pasos que debes ejecutar tú (requieren sudo)

## Problema detectado
`docker.service` y `docker.socket` están **masked** (bloqueados intencionalmente).
El socket sigue escuchando, así que probamos primero la vía rápida.

---

## Opción A — Vía rápida (prueba esto primero)

El socket Docker ya está activo. Comprueba si el daemon responde:

```bash
docker ps
```

Si ves la lista de contenedores (o "no containers"), Docker **ya funciona** sin necesidad de nada más. Dile a Antigravity `"docker funciona"` y él levanta todo.

---

## Opción B — Si `docker ps` da error de permisos

Agrega tu usuario al grupo docker (sin sudo para cada comando):

```bash
sudo usermod -aG docker $USER
newgrp docker
docker ps       # debe responder sin error
```

Dile a Antigravity `"docker funciona"` y él levanta todo.

---

## Opción C — Si `docker ps` dice "Cannot connect to the Docker daemon"

El daemon está completamente parado. Debes desenmascararlo y arrancarlo:

```bash
# 1. Desenmascarar
sudo systemctl unmask docker.service
sudo systemctl unmask docker.socket

# 2. Arrancar
sudo systemctl start docker.socket
sudo systemctl start docker.service

# 3. Verificar
docker ps
```

Dile a Antigravity `"docker funciona"` y él levanta todo.

---

## Opción D — Docker Desktop (si lo tienes instalado)

Si usas Docker Desktop en lugar del daemon clásico, ábrelo desde el menú de aplicaciones o:

```bash
systemctl --user start docker-desktop
```

Luego `docker ps` debe responder. Dile a Antigravity `"docker funciona"`.

---

> Una vez que cualquier opción funcione, Antigravity levantará automáticamente:
> - 🐘 Postgres (puerto 5434)
> - 🔴 Redis (puerto 6381)  
> - ⚙️  API (puerto 3000) con servicios externos mockeados
> - 🖥️  Kiosco paciente → http://localhost:5173
> - 🔧 Panel admin → http://localhost:5174
