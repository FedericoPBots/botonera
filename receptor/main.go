// Receptor de la Botonera: un ícono en la bandeja del sistema que se conecta al
// servidor y reproduce cada sonido que se manda al canal.
//
// La clave se pide en Slack con /sonido receptor y se pega desde el portapapeles.
// Por defecto solo suena mientras Slack está abierto, y arranca con la PC.
package main

import (
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"fyne.io/systray"
	"github.com/atotto/clipboard"
)

const servidor = "botonera.federico-a14.workers.dev"

var claveValida = regexp.MustCompile(`^[0-9a-f]{48}$`)

func main() {
	// Un solo receptor por compu: el segundo se da cuenta porque el puerto ya está tomado.
	candado, err := net.Listen("tcp", "127.0.0.1:47231")
	if err != nil {
		return
	}
	defer candado.Close()

	dir := carpetaConfig()
	if archivo, err := os.OpenFile(filepath.Join(dir, "receptor.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(archivo)
	}

	systray.Run(alAbrir, func() {})
}

func alAbrir() {
	cfg := leerConfig()
	if cfg.primeraVez {
		cfg.ArrancarConPC = true
		cfg.SoloConSlack = true
		guardarConfig(cfg)
		if err := arranqueAutomatico(true); err != nil {
			log.Printf("arranque automático: %v", err)
		}
	}

	systray.SetIcon(icono())
	systray.SetTooltip("Botonera")

	estado := systray.AddMenuItem("Iniciando…", "")
	estado.Disable()
	systray.AddSeparator()
	pegar := systray.AddMenuItem("Pegar clave del portapapeles", "La clave de /sonido receptor en Slack")
	silencio := systray.AddMenuItemCheckbox("Silenciar", "No reproducir nada", cfg.Silenciado)
	unaHora := systray.AddMenuItem("Silenciar 1 hora", "")
	soloSlack := systray.AddMenuItemCheckbox("Solo con Slack abierto", "En pausa mientras Slack está cerrado", cfg.SoloConSlack)
	arranque := systray.AddMenuItemCheckbox("Arrancar con la PC", "", cfg.ArrancarConPC)
	systray.AddSeparator()
	salir := systray.AddMenuItem("Salir", "")

	receptor := nuevoReceptor(cfg, func(texto string) {
		estado.SetTitle(texto)
		systray.SetTooltip("Botonera: " + texto)
	})
	go receptor.correr()

	go func() {
		for {
			select {
			case <-pegar.ClickedCh:
				texto, err := clipboard.ReadAll()
				clave := strings.Trim(strings.TrimSpace(texto), "`")
				if err != nil || !claveValida.MatchString(clave) {
					estado.SetTitle("El portapapeles no tiene una clave válida")
					continue
				}
				receptor.cambiar(func(c *Config) { c.Clave = clave }, true)
			case <-silencio.ClickedCh:
				receptor.cambiar(func(c *Config) { c.Silenciado = !c.Silenciado; c.SilencioHasta = time.Time{} }, false)
				marcar(silencio, receptor.config().Silenciado)
			case <-unaHora.ClickedCh:
				receptor.cambiar(func(c *Config) { c.SilencioHasta = time.Now().Add(time.Hour) }, false)
			case <-soloSlack.ClickedCh:
				receptor.cambiar(func(c *Config) { c.SoloConSlack = !c.SoloConSlack }, true)
				marcar(soloSlack, receptor.config().SoloConSlack)
			case <-arranque.ClickedCh:
				activar := !receptor.config().ArrancarConPC
				if err := arranqueAutomatico(activar); err != nil {
					log.Printf("arranque automático: %v", err)
					continue
				}
				receptor.cambiar(func(c *Config) { c.ArrancarConPC = activar }, false)
				marcar(arranque, activar)
			case <-salir.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func marcar(item *systray.MenuItem, activo bool) {
	if activo {
		item.Check()
	} else {
		item.Uncheck()
	}
}
