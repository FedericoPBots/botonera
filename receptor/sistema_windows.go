package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

// Sin ventana de consola cada vez que se llama a PowerShell o tasklist.
func comando(nombre string, args ...string) *exec.Cmd {
	cmd := exec.Command(nombre, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd
}

// El MediaPlayer de Windows lee MP3, WAV y casi todo; espera a que termine.
func reproducir(archivo string) error {
	ruta := strings.ReplaceAll(archivo, "'", "''")
	script := strings.Join([]string{
		"Add-Type -AssemblyName PresentationCore",
		"$p = New-Object System.Windows.Media.MediaPlayer",
		"$p.Open([Uri]'" + ruta + "')",
		"$i = 0",
		"while (-not $p.NaturalDuration.HasTimeSpan -and $i -lt 50) { Start-Sleep -Milliseconds 100; $i++ }",
		"if (-not $p.NaturalDuration.HasTimeSpan) { exit 1 }",
		"$p.Play()",
		"Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 200)",
		"$p.Close()",
	}, "; ")
	return comando("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Run()
}

func slackAbierto() bool {
	salida, err := comando("tasklist", "/FI", "IMAGENAME eq slack.exe", "/NH").Output()
	return err == nil && strings.Contains(strings.ToLower(string(salida)), "slack.exe")
}

const claveInicio = `Software\Microsoft\Windows\CurrentVersion\Run`

func arranqueAutomatico(activar bool) error {
	clave, err := registry.OpenKey(registry.CURRENT_USER, claveInicio, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer clave.Close()
	if !activar {
		if err := clave.DeleteValue("Botonera"); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	ejecutable, err := os.Executable()
	if err != nil {
		return err
	}
	return clave.SetStringValue("Botonera", `"`+ejecutable+`"`)
}
