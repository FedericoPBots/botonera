package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// El primer reproductor que haya instalado; ffplay y mpg123 leen MP3, paplay depende de la distro.
func reproducir(archivo string) error {
	opciones := [][]string{
		{"ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", archivo},
		{"mpg123", "-q", archivo},
		{"paplay", archivo},
	}
	for _, opcion := range opciones {
		if _, err := exec.LookPath(opcion[0]); err == nil {
			return exec.Command(opcion[0], opcion[1:]...).Run()
		}
	}
	return errors.New("no hay reproductor: instalá ffmpeg o mpg123")
}

func slackAbierto() bool {
	return exec.Command("pgrep", "-x", "slack").Run() == nil
}

func arranqueAutomatico(activar bool) error {
	base, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	archivo := filepath.Join(base, "autostart", "botonera.desktop")
	if !activar {
		if err := os.Remove(archivo); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	ejecutable, err := os.Executable()
	if err != nil {
		return err
	}
	contenido := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Botonera\nExec=\"%s\"\nX-GNOME-Autostart-enabled=true\n", ejecutable)
	os.MkdirAll(filepath.Dir(archivo), 0o755)
	return os.WriteFile(archivo, []byte(contenido), 0o644)
}
