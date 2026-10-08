# Mi Bombo v2

Versión inicial completa de la plataforma:

- Chat global en tiempo real con Socket.IO.
- Registro/login persistente.
- Contraseñas almacenadas con `scrypt` + salt; nunca en texto plano.
- Saldo exclusivamente virtual.
- 1.000 créditos iniciales.
- Saldo máximo: 5.000 créditos.
- Obtención gratuita limitada a 1.500 créditos/día.
- Botón de +10 créditos con cooldown.
- Combo de 8 flechas, inspirado en la mecánica de precisión temporal de juegos rítmicos, sin música ni arte; recompensa +75 dentro del límite diario.
- Ruleta virtual.
- Slots virtuales.
- Historial interno de transacciones.
- SQLite persistente.
- Nginx/Socket.IO compatible.

## Importante

Esta versión no incorpora dinero real, depósitos, retiradas, compras ni conversión de créditos virtuales a dinero. Las apuestas son una mecánica de juego virtual.

## Instalación en Ubuntu 24.04

El proyecto está pensado para reemplazar `/home/ubuntu/mibombochat`.

```bash
sudo apt update
sudo apt install -y build-essential nginx
# Instala Node.js 20+ si tu servidor todavía no lo tiene.
node -v
npm -v
```

Copiar el proyecto:

```bash
sudo mkdir -p /home/ubuntu/mibombochat
sudo cp -r . /home/ubuntu/mibombochat/
sudo chown -R ubuntu:ubuntu /home/ubuntu/mibombochat
cd /home/ubuntu/mibombochat
npm install
```

Probar manualmente:

```bash
npm start
```

En otra terminal:

```bash
curl http://127.0.0.1:3000
```

## Servicio systemd

```bash
sudo cp deploy/mibombo.service /etc/systemd/system/mibombo.service
sudo systemctl daemon-reload
sudo systemctl enable --now mibombo
sudo systemctl status mibombo
```

## Nginx

La configuración incluida mantiene `/miwebprofesional/` apuntando a `/var/www/html` y hace proxy del resto hacia Node.

```bash
sudo cp deploy/nginx-mibombo.conf /etc/nginx/sites-available/default
sudo nginx -t
sudo systemctl reload nginx
```

## Datos

La base se crea automáticamente en:

`data/mibombo.sqlite`

Haz copia de esa carpeta antes de actualizaciones importantes.
