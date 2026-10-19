# Botonera

Botonera de sonidos para Slack: `/sonido` abre la botonera y el sonido se publica en el canal con el nombre de quien lo mandó. El receptor de escritorio lo reproduce solo en la compu de quien lo tenga instalado.

- `app/`: servidor en Cloudflare Workers (comandos de Slack, sonidos en KV, aviso a los receptores).
- `receptor/`: receptor de escritorio en Go (ícono en la bandeja del sistema).

## Instalar el receptor

Bajá el archivo de tu sistema de la release **receptor**: `Botonera-mac.zip`, `Botonera-windows.zip` o `Botonera-linux-amd64.tar.gz`. Cada uno trae un `LEEME.txt` con la instalación paso a paso, cómo conectarlo con `/sonido receptor` y todos los comandos de la Botonera. Los textos están en `receptor/leeme/`.

Arranca solo con la compu y suena solo mientras Slack está abierto; las dos cosas se cambian desde el menú del ícono.

## Desarrollo

- Servidor: `cd app && npx wrangler deploy`. Secretos: `BOT_TOKEN`, `SIGNING_SECRET` (`npx wrangler secret put ...`).
- Receptor: cada push a `main` que toca `receptor/` rearma los tres sistemas en GitHub Actions y los sube a la release **receptor**.
