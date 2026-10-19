package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func reproducir(archivo string) error {
	return exec.Command("afplay", archivo).Run()
}

func slackAbierto() bool {
	return exec.Command("pgrep", "-x", "Slack").Run() == nil
}

func arranqueAutomatico(activar bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	plist := filepath.Join(home, "Library", "LaunchAgents", "com.botonera.receptor.plist")
	if !activar {
		if err := os.Remove(plist); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	ejecutable, err := os.Executable()
	if err != nil {
		return err
	}
	contenido := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.botonera.receptor</string>
  <key>ProgramArguments</key><array><string>%s</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`, ejecutable)
	os.MkdirAll(filepath.Dir(plist), 0o755)
	return os.WriteFile(plist, []byte(contenido), 0o644)
}
