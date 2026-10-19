# Botonera

Botonera de sonidos para Slack: `/sonido` abre la botonera y el sonido se publica en el canal con el nombre de quien lo mandó. El receptor de escritorio lo reproduce solo en la compu de quien lo tenga instalado.

- `app/`: servidor en Cloudflare Workers (comandos de Slack, sonidos en KV, aviso a los receptores).
- `receptor/`: receptor de escritorio en Go (ícono en la bandeja del sistema).

## Instalar el receptor

Bajá el archivo de tu sistema de la release **receptor** y pedí tu clave en Slack con `/sonido receptor`. Después, en el ícono de la Botonera: **Pegar clave del portapapeles**.

| Sistema | Archivo | Primera vez |
| --- | --- | --- |
| Mac | `Botonera-mac.zip` | Descomprimí y mové `Botonera.app` a Aplicaciones. Al abrirla, macOS la bloquea porque no tiene firma de Apple: Ajustes del Sistema → Privacidad y seguridad → **Abrir igualmente**. El ícono aparece en la barra de menú. |
| Windows | `Botonera.exe` | Si aparece "editor desconocido": Más información → **Ejecutar de todas formas**. El ícono aparece al lado del reloj. |
| Linux | `Botonera-linux-amd64.tar.gz` | `tar -xzf Botonera-linux-amd64.tar.gz && ./botonera`. Necesita `mpg123` o `ffmpeg`, y en GNOME la extensión AppIndicator. |

Arranca solo con la compu y suena solo mientras Slack está abierto; las dos cosas se cambian desde el menú del ícono.

## Desarrollo

- Servidor: `cd app && npx wrangler deploy`. Secretos: `BOT_TOKEN`, `SIGNING_SECRET` (`npx wrangler secret put ...`).
- Receptor: cada push a `main` que toca `receptor/` rearma los tres sistemas en GitHub Actions y los sube a la release **receptor**.
